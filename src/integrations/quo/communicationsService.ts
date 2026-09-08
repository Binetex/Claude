import { commGroupOf } from "./communicationsView";
import { collapseSendAttempts } from "./collapseAttempts";
import "server-only";
/**
 * Серверные операции истории коммуникаций (чтение из локальной БД, не из QUO):
 *  - markOrderCommunicationsRead: при открытии заказа помечает входящие SMS и пропущенные звонки прочитанными (глобально/командно);
 *  - linkCommunicationToOrder / ignoreCommunication: ручная привязка / игнор нераспознанных;
 *  - listOtherThreads: непривязанные события, собранные в переписки (раздел «Другие сообщения»);
 *  - suggestOrdersForCommunication: предполагаемые заказы по номеру;
 *  - indicatorsForOrders: агрегаты для списка заказов.
 * Доступ к этим операциям — на уровне вызывающих server actions (любой аутентифицированный).
 */
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { findCandidateOrdersByPhone } from "./ingest";
import { classifyThread, isTopicKey, type TopicKey } from "./otherMessages";
import { isCallRequest } from "@/modules/assistant/policy";
import { toE164 } from "@/lib/phone";

export type OrderPhoneSide = "CUSTOMER" | "RECIPIENT";

/**
 * Непривязанные QUO-сообщения по телефону стороны заказа, СТРОГО в рамках QUO-номера этого магазина.
 * Берём только: orderId=null, не ignored, provider=QUO, externalPhoneNormalized == телефон стороны,
 * providerPhoneNumberId == quoPhoneNumberId сайта заказа. Уже привязанные (в т.ч. к другим заказам)
 * и сообщения другого магазина НЕ трогаются. Ничего не пишет — только читает.
 */
export async function findUnlinkedCommunicationsForOrderPhone(
  prisma: PrismaClient,
  orderId: string,
  side: OrderPhoneSide
): Promise<{ ids: string[]; phoneE164: string | null; siteQuoPhoneNumberId: string | null }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { senderPhone: true, recipientPhone: true, site: { select: { quoPhoneNumberId: true } } },
  });
  if (!order) return { ids: [], phoneE164: null, siteQuoPhoneNumberId: null };

  const phoneE164 = toE164(side === "CUSTOMER" ? order.senderPhone : order.recipientPhone);
  const pn = order.site?.quoPhoneNumberId ?? null;
  if (!phoneE164 || !pn) return { ids: [], phoneE164, siteQuoPhoneNumberId: pn };

  const rows = await prisma.orderCommunication.findMany({
    where: { orderId: null, ignoredAt: null, provider: "QUO", externalPhoneNormalized: phoneE164, providerPhoneNumberId: pn },
    select: { id: true },
  });
  return { ids: rows.map((r) => r.id), phoneE164, siteQuoPhoneNumberId: pn };
}

/**
 * Привязывает найденные непривязанные сообщения к заказу с ролью стороны. Идемпотентно
 * (updateMany строго по orderId=null), чужие/уже привязанные и другой магазин не трогает.
 */
export async function attachUnlinkedCommunicationsToOrder(prisma: PrismaClient, orderId: string, side: OrderPhoneSide): Promise<{ attached: number }> {
  const { ids } = await findUnlinkedCommunicationsForOrderPhone(prisma, orderId, side);
  if (ids.length === 0) return { attached: 0 };
  const r = await prisma.orderCommunication.updateMany({
    where: { id: { in: ids }, orderId: null, ignoredAt: null },
    data: { orderId, partyRole: side },
  });
  return { attached: r.count };
}
import { matchCommunicationToOrder } from "./matching";
import { computeIndicators, type OrderIndicator } from "./communicationsView";

export type CommAttachment = { url: string; type: string | null };

export type CommunicationCardItem = {
  id: string;
  type: "SMS" | "CALL" | "VOICEMAIL";
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  partyRole: "CUSTOMER" | "RECIPIENT" | "UNKNOWN";
  externalPhone: string;
  messageText: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  transcript: string | null;
  summary: string | null;
  attachments: CommAttachment[];
  occurredAt: string;
  sentByName: string | null;
  /** Ключ отправки: по нему свёртываются попытки одного job'а (collapseSendAttempts). */
  sendKey?: string | null;
};

/** Нормализует OrderCommunication.attachmentsJson (MMS media [{url,type}]) в безопасный массив. */
export function parseAttachments(json: Prisma.JsonValue | null | undefined): CommAttachment[] {
  if (!Array.isArray(json)) return [];
  const out: CommAttachment[] = [];
  for (const x of json) {
    if (x && typeof x === "object" && "url" in x) {
      const url = (x as { url?: unknown }).url;
      if (typeof url === "string" && url) {
        const t = (x as { type?: unknown }).type;
        out.push({ url, type: typeof t === "string" ? t : null });
      }
    }
  }
  return out;
}

/**
 * Данные блока «Общение» для карточки заказа (owner/call-center/florist — единый вид, любой роль).
 * ПОМЕЧАЕТ входящие/пропущенные прочитанными при открытии. История — из локальной БД. Best-effort:
 * недоступность QUO-таблиц не должна ронять карточку (вызывающий оборачивает в try/catch).
 */
/**
 * Непрочитанные (входящие SMS / пропущенные звонки) по стороне заказа — считать ДО пометки
 * прочитанным.
 *
 * Разбор идёт по ФАКТИЧЕСКОМУ номеру сообщения, тем же `commGroupOf`, что и вкладки. Раньше
 * считалось по сохранённой роли, и на заказе с исправленным телефоном заказчика значок «2»
 * висел на вкладке, под которой уже ничего не было: роль говорила «CUSTOMER», а номер — что
 * это переписка с получателем.
 */
export async function countUnreadBySide(
  prisma: PrismaClient,
  orderId: string
): Promise<{ customer: number; recipient: number }> {
  const [order, rows] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, select: { senderPhone: true, recipientPhone: true } }),
    prisma.orderCommunication.findMany({
      where: { orderId, readAt: null, OR: [{ type: "SMS", direction: "INBOUND" }, { type: { in: ["CALL", "VOICEMAIL"] }, status: "MISSED" }] },
      select: { externalPhone: true, partyRole: true },
    }),
  ]);

  const out = { customer: 0, recipient: 0 };
  if (!order) return out;

  for (const r of rows) {
    // SAME — одна вкладка на оба номера; её значок компонент складывает из двух чисел.
    if (commGroupOf(r, order.senderPhone, order.recipientPhone) === "RECIPIENT") out.recipient += 1;
    else out.customer += 1;
  }
  return out;
}

/** Что выбираем из строки общения для ленты. Один список на всех, кто её показывает. */
const CARD_SELECT = {
  id: true, type: true, direction: true, status: true, partyRole: true, externalPhone: true,
  messageText: true, durationSeconds: true, recordingUrl: true, transcript: true, summary: true,
  attachmentsJson: true, occurredAt: true, sentByUserId: true, sendKey: true,
} as const;

/** Строка БД → элемент ленты. Третьей копии этого маппинга быть не должно. */
function toCardItem(
  c: Prisma.OrderCommunicationGetPayload<{ select: typeof CARD_SELECT }>,
  nameById: Map<string, string>
): CommunicationCardItem {
  return {
    id: c.id, type: c.type, direction: c.direction, status: c.status, partyRole: c.partyRole,
    externalPhone: c.externalPhone, messageText: c.messageText, durationSeconds: c.durationSeconds,
    recordingUrl: c.recordingUrl, transcript: c.transcript, summary: c.summary,
    attachments: parseAttachments(c.attachmentsJson),
    occurredAt: c.occurredAt.toISOString(),
    sentByName: c.sentByUserId ? nameById.get(c.sentByUserId) ?? null : null,
    sendKey: c.sendKey,
  };
}

async function namesOf(prisma: PrismaClient, rows: { sentByUserId: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.sentByUserId).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * Лента общения ПО НОМЕРУ, а не по заказу — для экранов, где предмет разговора человек, а не
 * заказ (карточка запроса отзыва).
 *
 * Отличий от заказной версии два, и оба намеренные: прочитанным ничего НЕ помечаем (открытие
 * чужого экрана не должно гасить счётчик непрочитанного у заказа) и не считаем `unread` —
 * счётчик по сторонам заказа здесь бессмыслен.
 */
export async function loadPhoneCommunicationsCard(
  prisma: PrismaClient,
  input: {
    phoneE164: string;
    /** null — переписка на QUO-номере, который не привязан ни к одному магазину. */
    siteId: string | null;
    take?: number;
    /**
     * Сузить ленту до одного QUO-номера магазина. Нужно «Другим сообщениям»: один и тот же
     * человек мог писать в два разных магазина, и мешать эти разговоры в одну ленту нельзя.
     * По умолчанию не задан — экран отзывов показывает всю переписку с номером, как и раньше.
     */
    providerPhoneNumberId?: string | null;
  }
): Promise<{ communications: CommunicationCardItem[]; storeHasQuoNumber: boolean; storeTimeZone: string | undefined }> {
  const [comms, site] = await Promise.all([
    prisma.orderCommunication.findMany({
      where: {
        externalPhoneNormalized: input.phoneE164,
        ...(input.providerPhoneNumberId !== undefined ? { providerPhoneNumberId: input.providerPhoneNumberId } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: input.take ?? 200,
      select: CARD_SELECT,
    }),
    input.siteId
      ? prisma.site.findUnique({ where: { id: input.siteId }, select: { quoPhoneNumberId: true, quoEnabled: true, timezone: true } })
      : Promise.resolve(null),
  ]);
  const nameById = await namesOf(prisma, comms);
  return {
    // Попытки одной отправки (провал + удачный повтор) сворачиваются в одно сообщение — иначе
    // лента показывает их как дубли клиенту.
    communications: collapseSendAttempts(comms.map((c) => toCardItem(c, nameById))),
    storeHasQuoNumber: !!(site?.quoPhoneNumberId && site?.quoEnabled),
    storeTimeZone: site?.timezone ?? undefined,
  };
}

export async function loadOrderCommunicationsCard(prisma: PrismaClient, orderId: string): Promise<{ communications: CommunicationCardItem[]; storeHasQuoNumber: boolean; storeTimeZone: string | undefined; unread: { customer: number; recipient: number } }> {
  const unread = await countUnreadBySide(prisma, orderId).catch(() => ({ customer: 0, recipient: 0 }));
  await markOrderCommunicationsRead(prisma, orderId).catch(() => 0);
  const [comms, site] = await Promise.all([
    prisma.orderCommunication.findMany({
      where: { orderId },
      orderBy: { occurredAt: "desc" },
      take: 200,
      select: CARD_SELECT,
    }),
    prisma.site.findFirst({ where: { orders: { some: { id: orderId } } }, select: { quoPhoneNumberId: true, quoEnabled: true, timezone: true } }),
  ]);
  const nameById = await namesOf(prisma, comms);
  return {
    communications: comms.map((c) => toCardItem(c, nameById)),
    storeHasQuoNumber: !!(site?.quoPhoneNumberId && site?.quoEnabled),
    storeTimeZone: site?.timezone ?? undefined,
    unread,
  };
}

/** Помечает прочитанными входящие SMS и пропущенные звонки заказа. Возвращает число затронутых. */
export async function markOrderCommunicationsRead(prisma: PrismaClient, orderId: string): Promise<number> {
  const now = new Date();
  const r = await prisma.orderCommunication.updateMany({
    where: {
      orderId,
      readAt: null,
      OR: [
        { type: "SMS", direction: "INBOUND" },
        { type: { in: ["CALL", "VOICEMAIL"] }, status: "MISSED" },
      ],
    },
    data: { readAt: now },
  });
  return r.count;
}

export async function linkCommunicationToOrder(prisma: PrismaClient, communicationId: string, orderId: string): Promise<{ ok: boolean; reason?: string }> {
  const [comm, order] = await Promise.all([
    prisma.orderCommunication.findUnique({ where: { id: communicationId }, select: { id: true } }),
    prisma.order.findUnique({ where: { id: orderId }, select: { id: true } }),
  ]);
  if (!comm) return { ok: false, reason: "communication_not_found" };
  if (!order) return { ok: false, reason: "order_not_found" };
  await prisma.orderCommunication.update({ where: { id: communicationId }, data: { orderId, ignoredAt: null } });
  return { ok: true };
}

export async function ignoreCommunication(prisma: PrismaClient, communicationId: string): Promise<{ ok: boolean; reason?: string }> {
  const comm = await prisma.orderCommunication.findUnique({ where: { id: communicationId }, select: { id: true } });
  if (!comm) return { ok: false, reason: "communication_not_found" };
  await prisma.orderCommunication.update({ where: { id: communicationId }, data: { ignoredAt: new Date() } });
  return { ok: true };
}

/**
 * ── «Другие сообщения»: переписки, а не отдельные события ──────────────────────────────────
 *
 * Одна строка списка = разговор с одним номером через один QUO-номер магазина. Плоский список
 * событий читать невозможно: половина входящих вне контекста бессмысленна («Yes», «?», «Here»),
 * а на 2355 событий приходится всего ~1100 разговоров.
 *
 * Группируем В ПАМЯТИ, а не через groupBy: нужен текст последней реплики и список типов, а
 * groupBy их не отдаёт. Выборка ограничена take — раздел смотрят за период, а не за всю историю.
 */
export type OtherThread = {
  /** Ключ строки и адрес карточки: номер собеседника + QUO-номер магазина. */
  phone: string;
  phoneDisplay: string;
  providerPhoneNumberId: string | null;
  storePhone: string | null;
  /** Категория: ручная, если её поставил человек, иначе посчитанная правилом. */
  topic: TopicKey;
  topicIsManual: boolean;
  lastText: string | null;
  lastAt: Date;
  firstAt: Date;
  smsCount: number;
  callCount: number;
  /** Последнее событие — входящее: ход за нами. */
  waitingForUs: boolean;
  /** В переписке есть просьба перезвонить. */
  wantsCall: boolean;
  /** Ни одной SMS — только звонки. Отдельная вкладка по просьбе владельца. */
  callsOnly: boolean;
};

export type OtherThreadFilters = { from?: Date; to?: Date; phone?: string; providerPhoneNumberId?: string; take?: number };

export type OtherThreadsResult = {
  threads: OtherThread[];
  /**
   * Выборка упёрлась в лимит: часть событий за период не прочитана, и числа в строках занижены.
   * Экран обязан сказать об этом вслух — молча обрезанный список выглядит как полный.
   */
  truncated: boolean;
};

export async function listOtherThreads(prisma: PrismaClient, f: OtherThreadFilters = {}): Promise<OtherThreadsResult> {
  const where: Prisma.OrderCommunicationWhereInput = { orderId: null, ignoredAt: null };
  if (f.phone) where.externalPhoneNormalized = { contains: f.phone.replace(/[^\d+]/g, "") };
  if (f.providerPhoneNumberId) where.providerPhoneNumberId = f.providerPhoneNumberId;
  // Верхняя граница — СТРОГО меньше: вызывающий передаёт начало следующего дня. С `lte` на
  // полуночи выбранный день отрезался целиком, и фильтр «по сегодня» отдавал пустой список.
  if (f.from || f.to) where.occurredAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) };

  const take = f.take ?? 3000;
  const rows = await prisma.orderCommunication.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take,
    select: {
      type: true, direction: true, externalPhone: true, externalPhoneNormalized: true,
      providerPhoneNumberId: true, storePhone: true, messageText: true, transcript: true,
      summary: true, occurredAt: true, topicManual: true,
    },
  });

  type Acc = Omit<OtherThread, "topic" | "topicIsManual" | "callsOnly"> & { inboundTexts: string[]; manual: string | null };
  const byKey = new Map<string, Acc>();

  for (const r of rows) {
    // События без номера собеседника (в базе такие есть: служебные и обрывки вебхуков) в
    // переписки не собираем — иначе все они склеились бы в одну фальшивую строку «».
    if (!r.externalPhoneNormalized?.trim()) continue;
    const key = `${r.externalPhoneNormalized}|${r.providerPhoneNumberId ?? ""}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        phone: r.externalPhoneNormalized, phoneDisplay: r.externalPhone,
        providerPhoneNumberId: r.providerPhoneNumberId, storePhone: r.storePhone,
        lastText: null, lastAt: r.occurredAt, firstAt: r.occurredAt,
        smsCount: 0, callCount: 0, waitingForUs: false, wantsCall: false,
        inboundTexts: [], manual: null,
      };
      byKey.set(key, acc);
      // rows отсортированы по убыванию времени, значит первая встреченная запись — последняя
      // по времени: только по ней определяем «ход за нами» и текст превью.
      acc.waitingForUs = r.direction === "INBOUND";
      acc.lastText = r.messageText ?? r.summary ?? null;
    }
    if (r.type === "SMS") acc.smsCount += 1;
    else acc.callCount += 1;
    if (r.occurredAt < acc.firstAt) acc.firstAt = r.occurredAt;
    if (r.direction === "INBOUND") {
      const text = [r.messageText, r.transcript, r.summary].filter(Boolean).join(" ");
      if (text) acc.inboundTexts.push(text);
      if (r.messageText && isCallRequest(r.messageText)) acc.wantsCall = true;
    }
    // Ручная категория ставится сразу всей переписке, но подстраховываемся: берём первую
    // непустую, чтобы одна недообновлённая строка не отменяла решение человека.
    if (!acc.manual && r.topicManual) acc.manual = r.topicManual;
  }

  const threads = [...byKey.values()]
    .map(({ inboundTexts, manual, ...rest }) => ({
      ...rest,
      topic: manual && isTopicKey(manual) ? manual : classifyThread(inboundTexts),
      topicIsManual: !!(manual && isTopicKey(manual)),
      callsOnly: rest.smsCount === 0,
    }))
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());

  return { threads, truncated: rows.length >= take };
}

/**
 * Привязать к заказу ВСЮ переписку, а не одно событие.
 *
 * Поштучная привязка (linkCommunicationToOrder) оставляла остальные события разговора
 * непривязанными: строка не уходила из списка, и тот же разговор просил разбора снова.
 *
 * `orderId: null` в условии обязателен — уже привязанные к другим заказам события не трогаем.
 */
export async function linkThreadToOrder(
  prisma: PrismaClient,
  input: { phoneE164: string; providerPhoneNumberId: string | null; orderId: string }
): Promise<{ ok: boolean; linked: number; reason?: string }> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true } });
  if (!order) return { ok: false, linked: 0, reason: "order_not_found" };

  const res = await prisma.orderCommunication.updateMany({
    where: {
      orderId: null,
      externalPhoneNormalized: input.phoneE164,
      providerPhoneNumberId: input.providerPhoneNumberId,
    },
    // ignoredAt снимаем по той же причине, что и в поштучной привязке: событие вернулось в работу.
    data: { orderId: input.orderId, ignoredAt: null },
  });
  return { ok: true, linked: res.count };
}

/**
 * Ручная категория для ВСЕЙ переписки. Пишем всем её событиям, чтобы решение не зависело от
 * того, какое событие пришло последним.
 *
 * `orderId: null` в условии обязателен: тот же номер может фигурировать в живых заказах, и
 * метка «Спам» не должна сесть на переписку по заказу.
 */
export async function setThreadTopic(
  prisma: PrismaClient,
  input: { phoneE164: string; providerPhoneNumberId: string | null; topic: TopicKey | null }
): Promise<number> {
  const res = await prisma.orderCommunication.updateMany({
    where: {
      orderId: null,
      externalPhoneNormalized: input.phoneE164,
      providerPhoneNumberId: input.providerPhoneNumberId,
    },
    data: { topicManual: input.topic },
  });
  return res.count;
}

export type SuggestedOrder = { orderId: string; orderNumber: string; deliveryDate: Date; role: "CUSTOMER" | "RECIPIENT" };

/** Предполагаемые заказы для нераспознанного события (по нормализованному номеру + приоритет matcher'а). */
export async function suggestOrdersForCommunication(prisma: PrismaClient, communicationId: string): Promise<SuggestedOrder[]> {
  const comm = await prisma.orderCommunication.findUnique({ where: { id: communicationId }, select: { externalPhoneNormalized: true, occurredAt: true } });
  if (!comm) return [];
  const candidates = await findCandidateOrdersByPhone(prisma, comm.externalPhoneNormalized);
  if (candidates.length === 0) return [];
  const numbers = await prisma.order.findMany({ where: { id: { in: candidates.map((c) => c.orderId) } }, select: { id: true, orderNumber: true, deliveryDate: true } });
  const numById = new Map(numbers.map((n) => [n.id, n]));
  // Лучший — вперёд (по matcher'у), остальные по близости даты доставки.
  const best = matchCommunicationToOrder(comm.externalPhoneNormalized, comm.occurredAt, candidates);
  const bestId = best.matched ? best.orderId : null;
  return candidates
    .map((c) => ({ orderId: c.orderId, orderNumber: numById.get(c.orderId)?.orderNumber ?? c.orderId, deliveryDate: numById.get(c.orderId)?.deliveryDate ?? new Date(0), role: (c.senderPhoneE164 === comm.externalPhoneNormalized ? "CUSTOMER" : "RECIPIENT") as "CUSTOMER" | "RECIPIENT" }))
    .sort((a, b) => (a.orderId === bestId ? -1 : b.orderId === bestId ? 1 : Math.abs(a.deliveryDate.getTime() - comm.occurredAt.getTime()) - Math.abs(b.deliveryDate.getTime() - comm.occurredAt.getTime())));
}

/**
 * Повторная обработка непривязанных событий: для каждой коммуникации с orderId=null (не игнор)
 * заново прогоняет matcher по нормализованному телефону и привязывает, если теперь есть подходящий
 * заказ. Привязка НА УРОВНЕ СОБЫТИЯ (учитывает дату коммуникации). Возвращает число привязанных.
 */
export async function reprocessUnlinkedCommunications(prisma: PrismaClient, opts: { limit?: number } = {}): Promise<{ scanned: number; linked: number }> {
  const items = await prisma.orderCommunication.findMany({
    where: { orderId: null, ignoredAt: null },
    orderBy: { occurredAt: "desc" },
    take: opts.limit ?? 500,
    select: { id: true, externalPhoneNormalized: true, occurredAt: true, partyRole: true },
  });
  let linked = 0;
  for (const c of items) {
    const candidates = await findCandidateOrdersByPhone(prisma, c.externalPhoneNormalized);
    const m = matchCommunicationToOrder(c.externalPhoneNormalized, c.occurredAt, candidates);
    if (m.matched) {
      await prisma.orderCommunication.update({ where: { id: c.id }, data: { orderId: m.orderId, ...(c.partyRole === "UNKNOWN" ? { partyRole: m.partyRole } : {}) } });
      linked++;
    }
  }
  return { scanned: items.length, linked };
}

/** Индикаторы (непрочитанные/пропущенные/последний контакт/preview) для списка заказов. */
export async function indicatorsForOrders(prisma: PrismaClient, orderIds: string[]): Promise<Record<string, OrderIndicator>> {
  if (orderIds.length === 0) return {};
  const comms = await prisma.orderCommunication.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { occurredAt: "desc" },
    take: 2000,
    select: { orderId: true, type: true, direction: true, status: true, readAt: true, occurredAt: true, messageText: true },
  });
  return computeIndicators(comms);
}
