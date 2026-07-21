import "server-only";
/**
 * Серверные операции истории коммуникаций (чтение из локальной БД, не из QUO):
 *  - markOrderCommunicationsRead: при открытии заказа помечает входящие SMS и пропущенные звонки прочитанными (глобально/командно);
 *  - linkCommunicationToOrder / ignoreCommunication: ручная привязка / игнор нераспознанных;
 *  - listUnrecognized: непривязанные (orderId=null) и неигнорированные, с фильтрами;
 *  - suggestOrdersForCommunication: предполагаемые заказы по номеру;
 *  - indicatorsForOrders: агрегаты для списка заказов.
 * Доступ к этим операциям — на уровне вызывающих server actions (любой аутентифицированный).
 */
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { findCandidateOrdersByPhone } from "./ingest";
import { matchCommunicationToOrder } from "./matching";
import { computeIndicators, type OrderIndicator } from "./communicationsView";

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
  occurredAt: string;
  sentByName: string | null;
};

/**
 * Данные блока «Общение» для карточки заказа (owner/call-center/florist — единый вид, любой роль).
 * ПОМЕЧАЕТ входящие/пропущенные прочитанными при открытии. История — из локальной БД. Best-effort:
 * недоступность QUO-таблиц не должна ронять карточку (вызывающий оборачивает в try/catch).
 */
/** Непрочитанные (входящие SMS / пропущенные звонки) по стороне заказа — считать ДО пометки прочитанным. */
export async function countUnreadBySide(prisma: PrismaClient, orderId: string): Promise<{ customer: number; recipient: number }> {
  const rows = await prisma.orderCommunication.groupBy({
    by: ["partyRole"],
    where: { orderId, readAt: null, OR: [{ type: "SMS", direction: "INBOUND" }, { type: { in: ["CALL", "VOICEMAIL"] }, status: "MISSED" }] },
    _count: true,
  });
  const out = { customer: 0, recipient: 0 };
  for (const r of rows) {
    if (r.partyRole === "CUSTOMER") out.customer = r._count;
    else if (r.partyRole === "RECIPIENT") out.recipient = r._count;
  }
  return out;
}

export async function loadOrderCommunicationsCard(prisma: PrismaClient, orderId: string): Promise<{ communications: CommunicationCardItem[]; storeHasQuoNumber: boolean; storeTimeZone: string | undefined; unread: { customer: number; recipient: number } }> {
  const unread = await countUnreadBySide(prisma, orderId).catch(() => ({ customer: 0, recipient: 0 }));
  await markOrderCommunicationsRead(prisma, orderId).catch(() => 0);
  const [comms, site] = await Promise.all([
    prisma.orderCommunication.findMany({
      where: { orderId },
      orderBy: { occurredAt: "desc" },
      take: 200,
      select: { id: true, type: true, direction: true, status: true, partyRole: true, externalPhone: true, messageText: true, durationSeconds: true, recordingUrl: true, transcript: true, summary: true, occurredAt: true, sentByUserId: true },
    }),
    prisma.site.findFirst({ where: { orders: { some: { id: orderId } } }, select: { quoPhoneNumberId: true, timezone: true } }),
  ]);
  const senderIds = [...new Set(comms.map((c) => c.sentByUserId).filter((x): x is string => !!x))];
  const users = senderIds.length ? await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return {
    communications: comms.map((c) => ({
      id: c.id, type: c.type, direction: c.direction, status: c.status, partyRole: c.partyRole,
      externalPhone: c.externalPhone, messageText: c.messageText, durationSeconds: c.durationSeconds,
      recordingUrl: c.recordingUrl, transcript: c.transcript, summary: c.summary,
      occurredAt: c.occurredAt.toISOString(), sentByName: c.sentByUserId ? nameById.get(c.sentByUserId) ?? null : null,
    })),
    storeHasQuoNumber: !!site?.quoPhoneNumberId,
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

export type UnrecognizedFilters = { type?: "SMS" | "CALL" | "VOICEMAIL"; direction?: "INBOUND" | "OUTBOUND"; phone?: string; from?: Date; to?: Date; take?: number };

/** Непривязанные и неигнорированные события (раздел «Нераспознанные»), с фильтрами. */
export async function listUnrecognized(prisma: PrismaClient, f: UnrecognizedFilters = {}) {
  const where: Prisma.OrderCommunicationWhereInput = { orderId: null, ignoredAt: null };
  if (f.type) where.type = f.type;
  if (f.direction) where.direction = f.direction;
  if (f.phone) where.externalPhoneNormalized = { contains: f.phone.replace(/[^\d+]/g, "") };
  if (f.from || f.to) where.occurredAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
  return prisma.orderCommunication.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take: f.take ?? 200,
    select: { id: true, type: true, direction: true, status: true, partyRole: true, externalPhone: true, externalPhoneNormalized: true, messageText: true, durationSeconds: true, recordingUrl: true, transcript: true, summary: true, occurredAt: true },
  });
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
