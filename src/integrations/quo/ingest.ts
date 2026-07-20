import "server-only";
/**
 * Идемпотентная запись нормализованного события QUO в OrderCommunication + привязка к заказу.
 * Вызывается outbox-handler'ом (Phase 3). Ключевое:
 *  - дедуп по (provider, providerEventId) → повтор события не создаёт дубль;
 *  - message/call/call_ringing → создаём/обновляем запись коммуникации;
 *  - recording/transcript/summary → ОБНОВЛЯЮТ существующую запись звонка по call id (resourceId);
 *  - привязка к заказу — через чистый matcher по нормализованному телефону;
 *  - неоднозначные/нераспознанные → orderId=null (раздел «Нераспознанные»);
 *  - обогащение, пришедшее раньше call.completed → QuoIngestRetryableError (outbox повторит).
 * PII (телефон/текст/транскрипт) в логи не попадает.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { matchCommunicationToOrder, type CommOrderCandidate } from "./matching";
import { maskPhone, quoLog } from "./logging";
import type { NormalizedQuoEvent } from "./types";

/** Временная (ретраибельная) ошибка обработки — outbox повторит, событие не теряется. */
export class QuoIngestRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoIngestRetryableError";
  }
}

export type IngestResult =
  | { outcome: "created" | "updated" | "duplicate"; communicationId: string; orderId: string | null }
  | { outcome: "enriched"; matched: number }
  | { outcome: "skipped"; reason: string };

const CANDIDATE_WINDOW_MS = 90 * 24 * 3600 * 1000;

/** Находит заказы-кандидаты, где нормализованный телефон совпадает с покупателем/получателем. */
export async function findCandidateOrdersByPhone(prisma: PrismaClient, e164: string): Promise<CommOrderCandidate[]> {
  const select = { id: true, senderPhone: true, recipientPhone: true, deliveryDate: true, orderStatus: true } as const;
  // 1) Точное совпадение по строке (покрывает чисто сохранённые E.164).
  const exact = await prisma.order.findMany({ where: { OR: [{ senderPhone: e164 }, { recipientPhone: e164 }] }, select, take: 50 });
  // 2) Недавние заказы (покрывают разночтения форматирования) — фильтруем строго по toE164 в коде.
  const since = new Date(Date.now() - CANDIDATE_WINDOW_MS);
  const recent = await prisma.order.findMany({ where: { OR: [{ createdAt: { gte: since } }, { deliveryDate: { gte: since } }] }, select, take: 500 });
  const byId = new Map<string, (typeof exact)[number]>();
  for (const o of exact) byId.set(o.id, o);
  for (const o of recent) if (toE164(o.senderPhone) === e164 || toE164(o.recipientPhone) === e164) byId.set(o.id, o);
  return [...byId.values()].map((o) => ({
    orderId: o.id,
    senderPhoneE164: toE164(o.senderPhone),
    recipientPhoneE164: toE164(o.recipientPhone),
    deliveryDate: o.deliveryDate,
    orderStatus: o.orderStatus,
  }));
}

/** true, если «внешний» номер звонка совпадает с собственным номером магазина (self-call артефакт QUO). */
async function isCallToOwnStoreNumber(prisma: PrismaClient, phoneNumberId: string | null, externalPhone: string): Promise<boolean> {
  if (!phoneNumberId) return false;
  const ext = toE164(externalPhone);
  if (!ext) return false;
  const site = await prisma.site.findFirst({ where: { quoPhoneNumberId: phoneNumberId }, select: { quoPhoneNumber: true } });
  const own = site?.quoPhoneNumber ? toE164(site.quoPhoneNumber) : null;
  return !!own && own === ext;
}

export async function ingestQuoEvent(prisma: PrismaClient, event: NormalizedQuoEvent): Promise<IngestResult> {
  // ── Обогащение звонка: запись/транскрипт/summary → апдейт существующей записи по call id ──
  if (event.kind === "recording" || event.kind === "transcript" || event.kind === "summary") {
    if (!event.resourceId) return { outcome: "skipped", reason: "enrichment_without_resource" };
    const data: Prisma.OrderCommunicationUpdateManyMutationInput = {};
    if (event.kind === "recording") {
      data.recordingUrl = event.recordingUrl;
      if (event.durationSeconds != null) data.durationSeconds = event.durationSeconds;
    } else if (event.kind === "transcript") {
      data.transcript = event.transcript;
    } else {
      data.summary = event.summary;
    }
    const r = await prisma.orderCommunication.updateMany({ where: { provider: "QUO", providerResourceId: event.resourceId, type: { in: ["CALL", "VOICEMAIL"] } }, data });
    if (r.count === 0) {
      // Обогащение пришло раньше call.completed (гонка) — не теряем: пусть outbox повторит.
      throw new QuoIngestRetryableError(`parent_call_not_found:${event.kind}`);
    }
    quoLog("comm.enriched", { kind: event.kind, resourceId: event.resourceId, matched: r.count });
    return { outcome: "enriched", matched: r.count };
  }

  // ── Self-call артефакт QUO: «исходящий» звонок на СОБСТВЕННЫЙ номер магазина — не коммуникация ──
  // (QUO рядом с пропущенным входящим генерирует служебный outgoing-leg на номер самого магазина).
  if ((event.kind === "call" || event.kind === "call_ringing") && event.externalPhone) {
    if (await isCallToOwnStoreNumber(prisma, event.phoneNumberId, event.externalPhone)) {
      quoLog("comm.skipped_self_call", { providerEventId: event.providerEventId, phoneNumberId: event.phoneNumberId });
      return { outcome: "skipped", reason: "self_call" };
    }
  }

  // ── Дедуп точного повтора события ──
  const dup = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: event.providerEventId } } });
  if (dup) {
    quoLog("comm.duplicate", { providerEventId: event.providerEventId });
    return { outcome: "duplicate", communicationId: dup.id, orderId: dup.orderId };
  }

  // ── Переход статуса существующей записи (ringing→completed, pending→delivered) по resourceId ──
  const existing = event.resourceId
    ? await prisma.orderCommunication.findFirst({ where: { provider: "QUO", providerResourceId: event.resourceId }, orderBy: { createdAt: "asc" } })
    : null;
  if (existing) {
    const advance = existing.status === "PENDING" || existing.status === "SENT";
    const updated = await prisma.orderCommunication.update({
      where: { id: existing.id },
      data: {
        ...(advance ? { status: event.status } : {}),
        ...(event.durationSeconds != null ? { durationSeconds: event.durationSeconds } : {}),
        ...(event.status === "DELIVERED" ? { deliveredAt: new Date(event.occurredAt) } : {}),
      },
    });
    quoLog("comm.updated", { providerEventId: event.providerEventId, resourceId: event.resourceId, status: updated.status });
    return { outcome: "updated", communicationId: updated.id, orderId: updated.orderId };
  }

  // ── Новая коммуникация: привязка к заказу по нормализованному телефону ──
  let externalPhone = event.externalPhone;
  let e164 = toE164(event.externalPhone);
  // Если номер собеседника отсутствует (пропущенный без участников), но событие принадлежит той же
  // беседе — берём номер ТОЛЬКО из подтверждённого соседнего события (не выдумываем).
  if (!e164 && event.conversationId) {
    const sibling = await prisma.orderCommunication.findFirst({
      where: { provider: "QUO", providerConversationId: event.conversationId, externalPhoneNormalized: { notIn: ["", externalPhone] } },
      orderBy: { createdAt: "asc" },
      select: { externalPhone: true, externalPhoneNormalized: true },
    });
    const recovered = sibling?.externalPhoneNormalized ? toE164(sibling.externalPhoneNormalized) : null;
    if (recovered) { externalPhone = sibling!.externalPhone; e164 = recovered; }
  }
  let orderId: string | null = null;
  let partyRole: "CUSTOMER" | "RECIPIENT" | "UNKNOWN" = "UNKNOWN";
  let matchReason = "no_phone";
  if (e164) {
    const candidates = await findCandidateOrdersByPhone(prisma, e164);
    const m = matchCommunicationToOrder(e164, new Date(event.occurredAt), candidates);
    if (m.matched) {
      orderId = m.orderId;
      partyRole = m.partyRole;
      matchReason = "matched";
    } else {
      matchReason = m.reason; // no_candidate | ambiguous → остаётся непривязанным
    }
  }

  try {
    const created = await prisma.orderCommunication.create({
      data: {
        orderId,
        provider: "QUO",
        providerEventId: event.providerEventId,
        providerResourceId: event.resourceId,
        providerConversationId: event.conversationId,
        providerUserId: event.userId,
        providerPhoneNumberId: event.phoneNumberId,
        type: event.type,
        direction: event.direction,
        partyRole,
        status: event.status,
        storePhone: event.storePhone,
        externalPhone,
        externalPhoneNormalized: e164 ?? externalPhone,
        messageText: event.messageText,
        durationSeconds: event.durationSeconds,
        recordingUrl: event.recordingUrl,
        transcript: event.transcript,
        summary: event.summary,
        attachmentsJson: event.media ? (event.media as unknown as Prisma.InputJsonValue) : undefined,
        occurredAt: new Date(event.occurredAt),
        deliveredAt: event.status === "DELIVERED" ? new Date(event.occurredAt) : null,
      },
      select: { id: true, orderId: true },
    });
    quoLog("comm.created", { providerEventId: event.providerEventId, kind: event.kind, type: event.type, direction: event.direction, status: event.status, partyRole, linked: orderId != null, matchReason, phone: maskPhone(event.externalPhone), textLen: event.messageText?.length ?? 0 });
    return { outcome: "created", communicationId: created.id, orderId };
  } catch (err) {
    // Гонка: параллельная доставка того же события успела создать запись → это не ошибка.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      const again = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: event.providerEventId } } });
      if (again) return { outcome: "duplicate", communicationId: again.id, orderId: again.orderId };
    }
    throw err;
  }
}
