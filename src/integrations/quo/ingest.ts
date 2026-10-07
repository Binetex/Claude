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
import { isP2002 } from "@/lib/prismaErrors";

/** Временная (ретраибельная) ошибка обработки — outbox повторит, событие не теряется. */
export class QuoIngestRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoIngestRetryableError";
  }
}

/** Внешние зависимости ingest (инъекция для тестируемости). */
export type QuoIngestDeps = {
  /** Догрузка записи звонка, если webhook `call.recording.completed` пришёл без URL (один GET к QUO). */
  fetchRecording?: (callId: string) => Promise<{ url: string | null; duration: number | null } | null>;
};

export type IngestResult =
  | { outcome: "created" | "updated" | "duplicate"; communicationId: string; orderId: string | null }
  | { outcome: "enriched"; matched: number; kind: "recording" | "transcript" | "summary"; communicationIds: string[] }
  | { outcome: "skipped"; reason: string };

const CANDIDATE_WINDOW_MS = 90 * 24 * 3600 * 1000;

/**
 * Находит заказы-кандидаты, где нормализованный телефон совпадает с покупателем/получателем.
 * `siteId` (если задан) ограничивает поиск ОДНИМ магазином — маршрутизация входящих QUO-событий
 * строго по номеру: событие номера магазина не может попасть в заказ другого магазина.
 */
export async function findCandidateOrdersByPhone(prisma: PrismaClient, e164: string, siteId?: string): Promise<CommOrderCandidate[]> {
  const select = { id: true, senderPhone: true, recipientPhone: true, deliveryDate: true, orderStatus: true } as const;
  const siteFilter = siteId ? { siteId } : {};
  // 1) Точное совпадение по строке (покрывает чисто сохранённые E.164).
  const exact = await prisma.order.findMany({ where: { ...siteFilter, OR: [{ senderPhone: e164 }, { recipientPhone: e164 }] }, select, take: 50 });
  // 2) Недавние заказы с теми же ПОСЛЕДНИМИ ЧЕТЫРЬМЯ цифрами — они стоят подряд в любой записи
  //    номера («9495337048», «(949) 533-7048»), — дальше строго по toE164 в коде. Раньше брались
  //    просто 500 недавних заказов без сортировки: у TheFlow за 90 дней их стало больше 500, и
  //    сегодняшний заказ в выборку не попадал — 01.10.2026 входящие получателя THEFLOW-20888 не
  //    привязались, в карточке заказа их не было, а бот считал номер незнакомым.
  const since = new Date(Date.now() - CANDIDATE_WINDOW_MS);
  const tail = e164.replace(/\D/g, "").slice(-4);
  const recent = tail.length < 4 ? [] : await prisma.order.findMany({
    where: {
      ...siteFilter,
      AND: [
        { OR: [{ createdAt: { gte: since } }, { deliveryDate: { gte: since } }] },
        { OR: [{ senderPhone: { contains: tail } }, { recipientPhone: { contains: tail } }] },
      ],
    },
    select,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
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

/** Магазин-владелец QUO-номера события — для маршрутизации входящих строго в свой Site. */
export async function resolveQuoSiteByPhoneNumberId(prisma: PrismaClient, phoneNumberId: string | null): Promise<{ id: string; quoEnabled: boolean } | null> {
  if (!phoneNumberId) return null;
  return prisma.site.findFirst({ where: { quoPhoneNumberId: phoneNumberId }, select: { id: true, quoEnabled: true } });
}

export async function ingestQuoEvent(prisma: PrismaClient, event: NormalizedQuoEvent, deps: QuoIngestDeps = {}): Promise<IngestResult> {
  // ── Обогащение звонка: запись/транскрипт/summary → апдейт существующей записи по call id ──
  if (event.kind === "recording" || event.kind === "transcript" || event.kind === "summary") {
    if (!event.resourceId) return { outcome: "skipped", reason: "enrichment_without_resource" };
    const data: Prisma.OrderCommunicationUpdateManyMutationInput = {};
    if (event.kind === "recording") {
      let url = event.recordingUrl;
      let duration = event.durationSeconds;
      // Webhook `call.recording.completed` часто НЕ содержит URL записи — делаем один GET к QUO.
      if (!url && deps.fetchRecording) {
        const fetched = await deps.fetchRecording(event.resourceId).catch(() => null);
        if (fetched?.url) { url = fetched.url; if (fetched.duration != null) duration = fetched.duration; }
      }
      if (url) data.recordingUrl = url; // не затираем существующий URL пустым значением
      if (duration != null) data.durationSeconds = duration;
    } else if (event.kind === "transcript") {
      data.transcript = event.transcript;
    } else {
      data.summary = event.summary;
    }
    const where: Prisma.OrderCommunicationWhereInput = { provider: "QUO", providerResourceId: event.resourceId, type: { in: ["CALL", "VOICEMAIL"] } };
    const r = await prisma.orderCommunication.updateMany({ where, data });
    if (r.count === 0) {
      // Обогащение пришло раньше call.completed (гонка) — не теряем: пусть outbox повторит.
      throw new QuoIngestRetryableError(`parent_call_not_found:${event.kind}`);
    }
    quoLog("comm.enriched", { kind: event.kind, resourceId: event.resourceId, matched: r.count });
    // Кому досталось обогащение — нужно вызывающему: расшифровка входящего звонка это новый
    // текст клиента, и ассистент обязан его увидеть.
    const touched = await prisma.orderCommunication.findMany({ where: { ...where, direction: "INBOUND" }, select: { id: true } });
    return { outcome: "enriched", matched: r.count, kind: event.kind, communicationIds: touched.map((t) => t.id) };
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

  // ── Наше SMS, ушедшее браузером Quo (browser/robot.ts): id сообщения у записи нет, его знает
  // только Quo. Без сверки вебхук завёл бы вторую запись — то же сообщение дважды в ленте заказа.
  const sentByBrowser = event.kind === "message" && event.direction === "OUTBOUND" ? await findBrowserSent(prisma, event) : null;
  if (sentByBrowser) {
    const updated = await prisma.orderCommunication.update({
      where: { id: sentByBrowser.id },
      data: {
        providerResourceId: event.resourceId,
        providerConversationId: event.conversationId,
        providerUserId: event.userId,
        status: event.status,
        ...(event.status === "DELIVERED" ? { deliveredAt: new Date(event.occurredAt) } : {}),
      },
    });
    quoLog("comm.browser_matched", { providerEventId: event.providerEventId, communicationId: updated.id, status: updated.status });
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
    if (event.phoneNumberId) {
      // Маршрутизация строго по номеру: сначала магазин-владелец номера, кандидаты — только его заказы.
      const site = await resolveQuoSiteByPhoneNumberId(prisma, event.phoneNumberId);
      if (!site) {
        matchReason = "unknown_site"; // номер не привязан ни к одному Site → не матчим (unlinked)
      } else if (!site.quoEnabled) {
        matchReason = "site_disabled"; // магазин выключен → событие не привязываем к его заказам
      } else {
        const candidates = await findCandidateOrdersByPhone(prisma, e164, site.id);
        const m = matchCommunicationToOrder(e164, new Date(event.occurredAt), candidates);
        if (m.matched) { orderId = m.orderId; partyRole = m.partyRole; matchReason = "matched"; }
        else matchReason = m.reason; // no_candidate | ambiguous → остаётся непривязанным
      }
    } else {
      // Событие без phoneNumberId (нетипично) — прежнее поведение без скоупа по магазину.
      const candidates = await findCandidateOrdersByPhone(prisma, e164);
      const m = matchCommunicationToOrder(e164, new Date(event.occurredAt), candidates);
      if (m.matched) { orderId = m.orderId; partyRole = m.partyRole; matchReason = "matched"; }
      else matchReason = m.reason;
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
    if (isP2002(err)) {
      const again = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: event.providerEventId } } });
      if (again) return { outcome: "duplicate", communicationId: again.id, orderId: again.orderId };
    }
    throw err;
  }
}

/** Окно сверки: вебхук приходит за секунды, но запас — на занятую очередь воркера. */
const BROWSER_MATCH_HOURS = 6;

/**
 * Наша запись об SMS, отправленной браузером, для исходящего из вебхука: тот же номер магазина,
 * тот же получатель, тот же текст (с точностью до пробелов), ещё без id сообщения. Картинка без
 * текста сверяется по тому, что в записи есть вложение. Из нескольких одинаковых — самая ранняя:
 * вебхуки приходят в порядке отправки. Вложения записи при этом не трогаем: наши ссылки на файл
 * живут у нас, а не у Quo.
 */
async function findBrowserSent(prisma: PrismaClient, event: NormalizedQuoEvent): Promise<{ id: string } | null> {
  const e164 = toE164(event.externalPhone);
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const text = norm(event.messageText ?? "");
  // Картинка без текста (MMS из карточки) — тоже наше сообщение: сверяем тогда по вложению.
  if (!e164 || !event.resourceId || (!text && !event.media?.length)) return null;
  const rows = await prisma.orderCommunication.findMany({
    where: {
      provider: "QUO",
      type: "SMS",
      direction: "OUTBOUND",
      providerResourceId: null,
      sendKey: { not: null },
      status: { in: ["PENDING", "SENT"] },
      externalPhoneNormalized: e164,
      ...(event.phoneNumberId ? { providerPhoneNumberId: event.phoneNumberId } : {}),
      rawMetadata: { path: ["via"], equals: "browser" },
      createdAt: { gte: new Date(Date.now() - BROWSER_MATCH_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, messageText: true, attachmentsJson: true },
  });
  return rows.find((r) => norm(r.messageText ?? "") === text && (!!text || (Array.isArray(r.attachmentsJson) && r.attachmentsJson.length > 0))) ?? null;
}
