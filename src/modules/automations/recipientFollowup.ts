import "server-only";
/**
 * «Получатель молчит» — эскалация после утреннего вопроса о готовности принять букет.
 *
 * Зачем: в день доставки получателю с указанной квартирой уходит SMS «сегодня у нас для вас
 * заказ, когда вам удобно?». Часто человек его не видит и не отвечает, курьер приезжает в
 * пустую квартиру. Владелец попросил: если ответа нет — переспросить, а если и тогда тишина —
 * сказать заказчику, чтобы он связался сам.
 *
 * Линия: вопрос → +60 мин повтор получателю → +20 мин сообщение заказчику. Каждый шаг РОВНО
 * один раз (`idempotencyKey` на заказ и волну), дальше цепочка конечна — третьего сообщения нет.
 *
 * Своего механизма отправки здесь НЕТ: шаги публикуют обычные триггеры автоматизаций, а текст,
 * канал, магазины и выключатель живут в правилах, которые владелец правит в «Автоматизациях».
 * Поэтому не нужен ни второй движок каналов, ни своя таблица состояния: «делали ли уже» знает
 * дедуп outbox, «ответил ли клиент» — переписка заказа.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationTrigger } from "./events";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { localHourInTz, todayStrInTz } from "@/lib/tz";
import { deliveryLocalDay } from "./dailySchedule";

export const RECIPIENT_FOLLOWUP_EVENT = "automation.recipient.followup";

/** Значения по умолчанию, если у магазина ничего не задано. Настраиваются в «Автоматизациях». */
export const WAIT_AFTER_ASK_MIN = 60;
export const WAIT_AFTER_RETRY_MIN = 20;

/** Разумные границы: минута тревожит зря, а сутки — уже после доставки. */
export const MIN_WAIT_MIN = 5;
export const MAX_WAIT_MIN = 12 * 60;

export function clampWait(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAIT_MIN, Math.max(MIN_WAIT_MIN, Math.round(value)));
}

/** Позже этого часа (время магазина) переспрашивать бессмысленно — день доставки заканчивается. */
export const QUIET_AFTER_HOUR = 20;

export type RecipientFollowupPayload = {
  orderId: string;
  /** 1 — повтор получателю, 2 — сообщение заказчику. */
  wave: 1 | 2;
  /** Момент отправки вопроса: ответом считается только то, что пришло ПОСЛЕ него. */
  askedAt: string;
  /** Номер получателя на момент вопроса (E.164). Ответ ищем по нему. */
  phoneNormalized: string;
  /**
   * Локальный день доставки на момент вопроса (YYYY-MM-DD). Дату доставки переносят, а вопрос
   * уходит заново на новый день — цепочка обязана считаться отдельной, иначе ключ старого дня
   * молча съедает новую. Поле необязательное: волны, запланированные до этой правки, его не несут.
   */
  deliveryDay?: string;
  /**
   * Правило, задавшее вопрос. Снятая галочка «Ждём ответ получателя» обязана гасить и уже
   * запущенную цепочку: иначе владелец выключил, а сообщения продолжают уходить людям.
   */
  automationId?: string;
};

/**
 * Ставит первую проверку после успешно отправленного вопроса.
 *
 * Ключ идемпотентности — заказ, ДЕНЬ ДОСТАВКИ и волна: в пределах одного дня повтор обработчика
 * (или второе правило с галочкой) второй цепочки не заведёт, а перенос доставки на другой день
 * начинает цепочку заново. Без дня в ключе получалось наоборот: заказ переносят, вопрос уходит
 * второй раз, а страховка молча не встаёт — именно на тех заказах, где получатель уже один раз
 * не отозвался. Best-effort: сбой планирования не должен ронять уже отправленное сообщение.
 */
export async function scheduleRecipientFollowup(
  prisma: PrismaClient,
  args: { orderId: string; phoneNormalized: string | null; sentAt: Date; automationId?: string }
): Promise<void> {
  if (!args.phoneNormalized) return; // отвечать некому — эскалировать нечего
  try {
    const order = await prisma.order.findUnique({
      where: { id: args.orderId },
      select: { deliveryDate: true, site: { select: { recipientRetryAfterMin: true } } },
    });
    // Цепочка живёт внутри дня доставки: без даты её не к чему привязать и незачем заводить.
    if (!order?.deliveryDate) return;
    const deliveryDay = deliveryLocalDay(order.deliveryDate);
    const waitMin = clampWait(order.site.recipientRetryAfterMin, WAIT_AFTER_ASK_MIN);
    const repo = new PrismaOutboxRepository(prisma);
    await repo.enqueue({
      eventType: RECIPIENT_FOLLOWUP_EVENT,
      aggregateType: "order",
      aggregateId: args.orderId,
      payload: {
        orderId: args.orderId,
        wave: 1,
        askedAt: args.sentAt.toISOString(),
        phoneNormalized: args.phoneNormalized,
        deliveryDay,
        ...(args.automationId ? { automationId: args.automationId } : {}),
      } satisfies RecipientFollowupPayload,
      idempotencyKey: `recipient-followup:${args.orderId}:${deliveryDay}:1`,
      availableAt: new Date(args.sentAt.getTime() + waitMin * 60_000),
    });
  } catch (err) {
    console.error(`[sms] scheduleRecipientFollowup failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Ответил ли получатель после вопроса.
 *
 * Ищем ПО НОМЕРУ, а не по `orderId`: входящее сообщение привязывается к заказу не всегда —
 * при двух похожих заказах на один номер связывание отдаёт «неоднозначно» и оставляет
 * `orderId` пустым. Проверка по заказу дала бы ложное «молчит» и повтор человеку, который
 * ответил. Пропущенный звонок тоже считается ответом: человек сообщение увидел и среагировал.
 */
export async function recipientAnswered(
  prisma: PrismaClient,
  args: { phoneNormalized: string; since: Date }
): Promise<boolean> {
  const found = await prisma.orderCommunication.findFirst({
    where: {
      direction: "INBOUND",
      externalPhoneNormalized: args.phoneNormalized,
      occurredAt: { gt: args.since },
    },
    select: { id: true },
  });
  return !!found;
}

/** Поздно ли по времени магазина — переспрашивать вечером в день доставки бессмысленно. */
function tooLateInStoreDay(timezone: string | null, now: Date): boolean {
  return localHourInTz(timezone, now) >= QUIET_AFTER_HOUR;
}

/**
 * Обработчик волны: молчит ли получатель — и если да, публикует триггер нужного шага.
 *
 * Гасим эскалацию, когда продолжать незачем: заказ закрыт (доставлен/отменён), получатель
 * ответил, наступил вечер, доставка переехала на другой день, владелец снял галочку у правила.
 * Волна 2 планируется ТОЛЬКО из волны 1 — если получатель ответил между шагами, до заказчика
 * сообщение уже не дойдёт.
 */
export function buildRecipientFollowupHandler(prisma: PrismaClient) {
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as RecipientFollowupPayload;
    if (!p?.orderId || !p?.phoneNormalized || !p?.askedAt) return;

    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: {
        id: true, siteId: true, orderStatus: true, deliveryStatus: true, deliveryDate: true,
        site: { select: { timezone: true, recipientAlertAfterMin: true } },
      },
    });
    if (!order) return; // заказ исчез — эскалировать нечего

    // Доставленный или отменённый заказ вопросов больше не требует.
    if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus) || order.deliveryStatus === "DELIVERED") return;

    const now = new Date();

    // Эскалация имеет смысл ТОЛЬКО в день доставки: вся её суть — успеть до приезда курьера.
    // Раньше это гарантировал сам триггер («Доставка сегодня»), теперь цепочку может завести
    // любое правило с галочкой, поэтому день проверяется здесь — в одном месте, а не в настройке.
    if (!order.deliveryDate) return;
    const deliveryDay = deliveryLocalDay(order.deliveryDate);
    // Дату перенесли после вопроса — эта волна относится к прошлому дню и адресату не нужна.
    if (p.deliveryDay && p.deliveryDay !== deliveryDay) return;
    if (deliveryDay !== todayStrInTz(order.site.timezone, now)) return;

    if (tooLateInStoreDay(order.site.timezone, now)) return;

    // Снятая галочка гасит и уже запущенную цепочку: владелец выключил — значит выключено.
    // Старые волны (запланированные до появления поля) правило не несут и доигрывают как раньше.
    if (p.automationId) {
      const rule = await prisma.automation.findUnique({
        where: { id: p.automationId },
        select: { active: true, deletedAt: true, awaitRecipientReply: true },
      });
      if (!rule || rule.deletedAt || !rule.active || !rule.awaitRecipientReply) return;
    }

    if (await recipientAnswered(prisma, { phoneNormalized: p.phoneNormalized, since: new Date(p.askedAt) })) return;

    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: order.id,
      siteId: order.siteId,
      triggerType: p.wave === 1 ? "RECIPIENT_NO_REPLY" : "RECIPIENT_UNREACHABLE",
      // Одна цепочка на заказ и день доставки: повторный заход обработчика не создаст второго
      // сообщения, а перенесённая на другой день доставка получает свою.
      occurrenceKey: `${order.id}:recipient-followup:${deliveryDay}:${p.wave}`,
    });

    if (p.wave === 1) {
      await repo.enqueue({
        eventType: RECIPIENT_FOLLOWUP_EVENT,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { ...p, wave: 2, deliveryDay } satisfies RecipientFollowupPayload,
        idempotencyKey: `recipient-followup:${order.id}:${deliveryDay}:2`,
        availableAt: new Date(now.getTime() + clampWait(order.site.recipientAlertAfterMin, WAIT_AFTER_RETRY_MIN) * 60_000),
      });
    }
  };
}
