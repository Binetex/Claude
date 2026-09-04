import "server-only";
/**
 * Ожидание ответа на отправленное сообщение — общий механизм цепочек.
 *
 * Как работает: правило отправило SMS. Если у правила указано «не ответят — запустить вот это»,
 * ставится отложенная проверка. К её сроку смотрим, ответил ли человек (входящее сообщение или
 * пропущенный звонок с того же номера ПОСЛЕ отправки). Молчит — запускаем указанное правило,
 * как обычное правило: со своими условиями, каналами, магазинами и текстом. У того правила
 * может быть своя ссылка — так собирается лесенка любой длины, без спец-событий и без кода
 * под каждый шаг.
 *
 * История: сначала это была зашитая эскалация «получатель молчит» ровно из двух шагов, с двумя
 * специальными событиями и галочкой только для SMS получателю. Владелец справедливо сказал, что
 * так зашили частный случай вместо механизма; здесь — механизм, а его сценарий это две ссылки.
 *
 * Своего движка отправки тут НЕТ: шаг запускается тем же путём, что и обычное событие заказа
 * (`publishAutomationTrigger` с указанием конкретного правила), поэтому рубильник, журнал,
 * привязка к магазинам и условия работают сами собой.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationTrigger } from "./events";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { CHAINED_TRIGGER } from "./triggers";
import { CHAIN_OCCURRENCE_PREFIX, MAX_CHAIN_MESSAGES, chainOccurrenceKey, clampWait } from "./chain";

/**
 * Значение eventType сохранено историческим: в очереди на момент перехода могли лежать уже
 * поставленные проверки, и переименование осиротило бы их (тот же приём, что в events.ts).
 */
export const REPLY_WAIT_EVENT = "automation.recipient.followup";

/** Значения по умолчанию, если у магазина ничего не задано. Настраиваются в «Автоматизациях». */
export const WAIT_FIRST_MIN = 60;
export const WAIT_NEXT_MIN = 20;

export type ReplyWaitPayload = {
  orderId: string;
  /** Правило, чьё сообщение ждёт ответа. Его ссылка читается СВЕЖЕЙ в момент проверки. */
  automationId: string;
  /** Отправленное сообщение — якорь ожидания. */
  jobId: string;
  /** Номер, на который писали (E.164). Ответ ищем по нему. */
  phoneNormalized: string;
  /** Момент отправки: ответом считается только то, что пришло ПОСЛЕ него. */
  askedAt: string;
  /**
   * «Случай» отправленного сообщения (occurrenceKey его job'а). По нему строится случай
   * следующего шага, поэтому два сообщения одного правила (аудитория «Оба») дают ОДНО
   * продолжение, а не два.
   */
  senderCase?: string | null;
};

/**
 * Ставит проверку после успешно отправленного сообщения.
 *
 * Ключ идемпотентности — отправленное сообщение (jobId). Одно сообщение — одно ожидание: повтор
 * обработчика второй проверки не создаст, а новое сообщение (в том числе то же правило на
 * перенесённую дату доставки) получит своё, потому что job у него другой.
 *
 * Best-effort: сбой планирования не должен ронять уже отправленное сообщение.
 */
export async function scheduleReplyWait(
  prisma: PrismaClient,
  args: {
    orderId: string;
    automationId: string;
    jobId: string;
    phoneNormalized: string | null;
    sentAt: Date;
    /** «Случай» отправленного сообщения — основа случая следующего шага. */
    senderCase: string | null;
    /** Само это сообщение пришло по цепочке — значит ждём «следующим» сроком, а не первым. */
    isChainStep: boolean;
  }
): Promise<void> {
  if (!args.phoneNormalized) return; // отвечать некому — ждать нечего
  try {
    const order = await prisma.order.findUnique({
      where: { id: args.orderId },
      select: { site: { select: { awaitReplyFirstMin: true, awaitReplyNextMin: true } } },
    });
    const waitMin = args.isChainStep
      ? clampWait(order?.site.awaitReplyNextMin, WAIT_NEXT_MIN)
      : clampWait(order?.site.awaitReplyFirstMin, WAIT_FIRST_MIN);

    const repo = new PrismaOutboxRepository(prisma);
    await repo.enqueue({
      eventType: REPLY_WAIT_EVENT,
      aggregateType: "order",
      aggregateId: args.orderId,
      payload: {
        orderId: args.orderId,
        automationId: args.automationId,
        jobId: args.jobId,
        phoneNormalized: args.phoneNormalized,
        askedAt: args.sentAt.toISOString(),
        senderCase: args.senderCase,
      } satisfies ReplyWaitPayload,
      idempotencyKey: `reply-wait:${args.jobId}`,
      availableAt: new Date(args.sentAt.getTime() + waitMin * 60_000),
    });
  } catch (err) {
    console.error(`[sms] scheduleReplyWait failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Ответил ли хоть кто-то из тех, кому ушло это сообщение.
 *
 * Ищем ПО НОМЕРАМ, а не по `orderId`: входящее сообщение привязывается к заказу не всегда —
 * при двух похожих заказах на один номер связывание отдаёт «неоднозначно» и оставляет
 * `orderId` пустым. Проверка по заказу дала бы ложное «молчит» и повтор человеку, который
 * ответил. Пропущенный звонок тоже считается ответом: человек сообщение увидел и среагировал.
 *
 * Номеров может быть несколько: правило с аудиторией «Оба» пишет и заказчику, и получателю.
 * Ответ ЛЮБОГО из них останавливает цепочку — иначе молчание одного отправляло бы продолжение
 * и тому, кто уже ответил.
 */
export async function repliedSince(
  prisma: PrismaClient,
  args: { phones: string[]; since: Date }
): Promise<boolean> {
  const phones = args.phones.filter(Boolean);
  if (phones.length === 0) return false;
  const found = await prisma.orderCommunication.findFirst({
    where: {
      direction: "INBOUND",
      externalPhoneNormalized: { in: phones },
      occurredAt: { gt: args.since },
    },
    select: { id: true },
  });
  return !!found;
}

/**
 * Одна строка в лог воркера на каждую остановку. Отдельного экрана у цепочек нет, а вопрос
 * «почему по заказу не ушло второе сообщение» возникает первым же — без этой строки на него
 * нечем ответить, кроме догадок.
 */
function stop(p: { orderId?: string; automationId?: string }, reason: string): void {
  console.info(`[sms] цепочка ответа: заказ ${p.orderId ?? "?"}, правило ${p.automationId ?? "?"} — остановлена: ${reason}`);
}

/**
 * Проверка ожидания: ответили — тишина; молчат — запускаем следующее правило цепочки.
 *
 * Цепочка гаснет, когда продолжать незачем: заказ закрыт (доставлен или отменён), человек
 * ответил, владелец убрал ссылку либо выключил правило (спрашивавшее или следующее), исчерпан
 * потолок сообщений цепочки на заказ.
 */
export function buildReplyWaitHandler(prisma: PrismaClient) {
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as ReplyWaitPayload;
    if (!p?.orderId || !p?.phoneNormalized || !p?.askedAt || !p?.automationId) {
      return stop(p ?? {}, "запись без обязательных полей");
    }
    // Записи СТАРОГО формата (двухволновая эскалация) в очереди на момент перехода. У них нет
    // ни jobId, ни случая сообщения, а «волна 2» означала шаг, который новая схема выражает
    // ссылкой у ДРУГОГО правила. Доигрывать их вслепую значит отправить не то сообщение и не
    // тому: волна 2 повторила бы получателю уже отправленный вопрос, а заказчик не получил бы
    // ничего. Останавливаемся явно и с записью в лог.
    if (!p.jobId) return stop(p, "запись старого формата (до перехода на цепочки)");

    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: { id: true, siteId: true, orderStatus: true, deliveryStatus: true },
    });
    if (!order) return; // заказ исчез — продолжать нечего

    // Доставленный или отменённый заказ вопросов больше не требует.
    if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus) || order.deliveryStatus === "DELIVERED") {
      return stop(p, "заказ доставлен или отменён");
    }

    // Правило-отправитель читается свежим: владелец мог убрать ссылку, выключить или удалить
    // само правило уже после отправки. Выключил — значит выключено, включая запущенное.
    const sender = await prisma.automation.findUnique({
      where: { id: p.automationId },
      select: { active: true, deletedAt: true, noReplyNextAutomationId: true },
    });
    if (!sender || sender.deletedAt || !sender.active) return stop(p, "правило-отправитель выключено или удалено");
    const nextId = sender.noReplyNextAutomationId;
    if (!nextId) return stop(p, "ссылка на следующее правило убрана");

    // Ответ ищем по ВСЕМ адресатам этого сообщения: правило с аудиторией «Оба» пишет двоим,
    // и ответ любого из них означает, что продолжать не надо.
    const phones = await addresseePhones(prisma, p);
    if (await repliedSince(prisma, { phones, since: new Date(p.askedAt) })) {
      return stop(p, "человек ответил");
    }

    // Потолок сообщений цепочки на заказ — последний рубеж против кольца в настройке. Считаем
    // ШАГИ (разные случаи), а не job'ы: у шага с аудиторией «Оба» их два, плюс пропущенные и
    // письма, и по job'ам лесенка обрывалась бы втрое раньше объявленного.
    const steps = await prisma.automationJob.findMany({
      where: { orderId: order.id, occurrenceKey: { startsWith: CHAIN_OCCURRENCE_PREFIX } },
      distinct: ["occurrenceKey"],
      select: { occurrenceKey: true },
    });
    if (steps.length >= MAX_CHAIN_MESSAGES) {
      return stop(p, `достигнут потолок ${MAX_CHAIN_MESSAGES} сообщений цепочки на заказ`);
    }

    const next = await prisma.automation.findUnique({
      where: { id: nextId },
      select: { id: true, active: true, deletedAt: true, sites: { where: { siteId: order.siteId }, select: { siteId: true } } },
    });
    // Правило выключено, удалено или не подключено к магазину заказа — цепочка кончается, как
    // и обычное правило, которое не сработало: сообщение живому человеку важнее «доведём любой
    // ценой».
    if (!next || next.deletedAt) return stop(p, "следующее правило удалено");
    if (!next.active) return stop(p, "следующее правило выключено");
    if (next.sites.length === 0) return stop(p, "следующее правило не подключено к магазину заказа");

    const repo = new PrismaOutboxRepository(prisma);
    // Запуск — обычным путём события заказа, но адресно (одно правило). Отсюда работают
    // рубильник, условия правила, дедуп телефонов, задержка и журнал — своего пути отправки нет.
    await publishAutomationTrigger(repo, {
      orderId: order.id,
      siteId: order.siteId,
      triggerType: CHAINED_TRIGGER,
      // Случай — по правилу-получателю и сообщению, на которое не ответили: два разных правила,
      // указывающих на одно и то же следующее, дают человеку ОДНО сообщение, а не два.
      occurrenceKey: chainOccurrenceKey({
        nextAutomationId: next.id,
        orderId: order.id,
        senderCase: p.senderCase || p.jobId,
      }),
      automationId: next.id,
    });
  };
}

/**
 * Номера всех адресатов того же сообщения: у правила с аудиторией «Оба» их два, и ожидание
 * ставится на каждое отправленное SMS отдельно. Собираем по случаю сообщения — так же, как их
 * создавал планировщик.
 */
async function addresseePhones(prisma: PrismaClient, p: ReplyWaitPayload): Promise<string[]> {
  const own = [p.phoneNormalized];
  if (!p.senderCase) return own;
  const siblings = await prisma.automationJob.findMany({
    where: {
      orderId: p.orderId,
      automationId: p.automationId,
      occurrenceKey: p.senderCase,
      channel: "SMS",
      status: "SENT",
      phoneNormalized: { not: null },
    },
    select: { phoneNormalized: true },
  });
  const all = new Set(own);
  for (const s of siblings) if (s.phoneNormalized) all.add(s.phoneNormalized);
  return [...all];
}
