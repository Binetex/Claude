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
import { localTimeInTz } from "@/lib/tz";

export const RECIPIENT_FOLLOWUP_EVENT = "automation.recipient.followup";

/** Ждём ответа после вопроса; затем — после повтора. Значения выбраны владельцем. */
export const WAIT_AFTER_ASK_MIN = 60;
export const WAIT_AFTER_RETRY_MIN = 20;

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
};

/**
 * Ставит первую проверку после успешно отправленного вопроса.
 *
 * Ключ идемпотентности — заказ и волна, поэтому второе правило с тем же триггером (или повтор
 * обработчика) не заведёт вторую цепочку. Best-effort: сбой планирования не должен ронять уже
 * отправленное сообщение.
 */
export async function scheduleRecipientFollowup(
  prisma: PrismaClient,
  args: { orderId: string; phoneNormalized: string | null; sentAt: Date }
): Promise<void> {
  if (!args.phoneNormalized) return; // отвечать некому — эскалировать нечего
  try {
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
      } satisfies RecipientFollowupPayload,
      idempotencyKey: `recipient-followup:${args.orderId}:1`,
      availableAt: new Date(args.sentAt.getTime() + WAIT_AFTER_ASK_MIN * 60_000),
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

/** Час по времени магазина — чтобы не переспрашивать поздно вечером. */
function tooLateInStoreDay(timezone: string | null, now: Date): boolean {
  const hhmm = localTimeInTz(timezone, now); // "HH:MM"
  const hour = Number(hhmm.slice(0, 2));
  return Number.isFinite(hour) && hour >= QUIET_AFTER_HOUR;
}

/**
 * Обработчик волны: молчит ли получатель — и если да, публикует триггер нужного шага.
 *
 * Гасим эскалацию, когда продолжать незачем: заказ закрыт (доставлен/отменён), получатель
 * ответил, наступил вечер. Волна 2 планируется ТОЛЬКО из волны 1 — если получатель ответил
 * между шагами, до заказчика сообщение уже не дойдёт.
 */
export function buildRecipientFollowupHandler(prisma: PrismaClient) {
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as RecipientFollowupPayload;
    if (!p?.orderId || !p?.phoneNormalized || !p?.askedAt) return;

    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: { id: true, siteId: true, orderStatus: true, deliveryStatus: true, site: { select: { timezone: true } } },
    });
    if (!order) return; // заказ исчез — эскалировать нечего

    // Доставленный или отменённый заказ вопросов больше не требует.
    if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus) || order.deliveryStatus === "DELIVERED") return;

    const now = new Date();
    if (tooLateInStoreDay(order.site.timezone, now)) return;

    if (await recipientAnswered(prisma, { phoneNormalized: p.phoneNormalized, since: new Date(p.askedAt) })) return;

    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: order.id,
      siteId: order.siteId,
      triggerType: p.wave === 1 ? "RECIPIENT_NO_REPLY" : "RECIPIENT_UNREACHABLE",
      // Одна цепочка на заказ: повторный заход обработчика не создаст второго сообщения.
      occurrenceKey: `${order.id}:recipient-followup:${p.wave}`,
    });

    if (p.wave === 1) {
      await repo.enqueue({
        eventType: RECIPIENT_FOLLOWUP_EVENT,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { ...p, wave: 2 } satisfies RecipientFollowupPayload,
        idempotencyKey: `recipient-followup:${order.id}:2`,
        availableAt: new Date(now.getTime() + WAIT_AFTER_RETRY_MIN * 60_000),
      });
    }
  };
}
