/**
 * Разбор webhook-envelope QUO в нормализованное внутреннее событие (NormalizedQuoEvent).
 * Здесь и ТОЛЬКО здесь маппятся имена полей/типов QUO. Не решает привязку к заказу (это matcher)
 * и не пишет в БД. Чистый модуль — тестируется напрямую. Неизвестные типы → null (ingest пропустит).
 */
import type {
  QuoWebhookEnvelope,
  QuoMessageObject,
  QuoCallObject,
  QuoRecordingObject,
  QuoTranscriptObject,
  QuoSummaryObject,
  NormalizedQuoEvent,
  NormalizedCommStatus,
} from "./types";

function first(v: string[] | string | undefined | null): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

/** Собеседник/магазин по направлению: incoming → external=from, store=to; outgoing → наоборот. */
function partiesFor(direction: string | undefined, from: string | null, to: string | null): { externalPhone: string | null; storePhone: string | null } {
  if (direction === "outgoing") return { externalPhone: to, storePhone: from };
  // incoming (по умолчанию)
  return { externalPhone: from, storePhone: to };
}

function mapMessageStatus(quoStatus: string | undefined, eventType: string): NormalizedCommStatus {
  if (eventType === "message.received") return "RECEIVED";
  if (eventType === "message.delivered") return "DELIVERED";
  switch (quoStatus) {
    case "delivered": return "DELIVERED";
    case "sent": return "SENT";
    case "queued": return "PENDING";
    case "undelivered": return "FAILED";
    case "received": return "RECEIVED";
    default: return "SENT";
  }
}

function mapCallStatus(quoStatus: string | undefined): NormalizedCommStatus {
  switch (quoStatus) {
    case "completed":
    case "answered":
    case "forwarded":
      return "COMPLETED";
    case "missed":
    case "no-answer":
    case "busy":
    case "abandoned":
    case "canceled":
      return "MISSED";
    case "failed":
      return "FAILED";
    case "ringing":
    case "queued":
    case "initiated":
    case "in-progress":
      return "PENDING";
    default:
      return "COMPLETED";
  }
}

/** Собирает текст summary/transcript из разных возможных форм в единую строку. */
function joinText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    const s = v.map((x) => (typeof x === "string" ? x : "")).filter(Boolean).join("\n").trim();
    return s || null;
  }
  return null;
}

function transcriptToText(t: QuoTranscriptObject): string | null {
  if (t.text) return t.text.trim() || null;
  const dlg = Array.isArray(t.dialogue) ? t.dialogue : [];
  const s = dlg.map((d) => (d.content ?? "").trim()).filter(Boolean).join("\n").trim();
  return s || null;
}

export function parseQuoWebhook(input: unknown): NormalizedQuoEvent | null {
  const env = (typeof input === "string" ? safeJson(input) : input) as QuoWebhookEnvelope | null;
  if (!env || typeof env !== "object") return null;
  const providerEventId = env.id ?? null;
  const eventType = env.type ?? null;
  if (!providerEventId || !eventType) return null;
  const obj = (env.data?.object ?? null) as unknown;
  if (!obj || typeof obj !== "object") return null;

  const base = {
    providerEventId,
    eventType,
    conversationId: (obj as { conversationId?: string | null }).conversationId ?? null,
    userId: (obj as { userId?: string | null }).userId ?? null,
    phoneNumberId: (obj as { phoneNumberId?: string | null }).phoneNumberId ?? null,
    resourceId: (obj as { id?: string | null }).id ?? null,
    messageText: null as string | null,
    durationSeconds: null as number | null,
    media: null as { url: string; type: string | null }[] | null,
    recordingUrl: null as string | null,
    transcript: null as string | null,
    summary: null as string | null,
  };

  // ── Сообщения ──
  if (eventType === "message.received" || eventType === "message.delivered") {
    const m = obj as QuoMessageObject;
    const { externalPhone, storePhone } = partiesFor(m.direction, m.from ?? null, first(m.to));
    if (!externalPhone) return null;
    return {
      ...base,
      kind: "message",
      type: "SMS",
      direction: eventType === "message.received" ? "INBOUND" : "OUTBOUND",
      status: mapMessageStatus(m.status, eventType),
      externalPhone,
      storePhone,
      messageText: (m.body ?? m.text ?? null)?.toString() ?? null,
      media: Array.isArray(m.media) && m.media.length ? m.media.map((x) => ({ url: x.url, type: x.type ?? null })) : null,
      occurredAt: m.createdAt ?? env.createdAt ?? new Date().toISOString(),
    };
  }

  // ── Звонки (completed / ringing) ──
  if (eventType === "call.completed" || eventType === "call.ringing") {
    const c = obj as QuoCallObject;
    const isRinging = eventType === "call.ringing";
    const to = c.to ?? null;
    let external = null as string | null;
    let store = null as string | null;
    if (c.from || to) {
      ({ externalPhone: external, storePhone: store } = partiesFor(c.direction, c.from ?? null, to));
    } else if (Array.isArray(c.participants) && c.participants.length) {
      external = c.participants[0] ?? null; // fallback: без from/to берём первого участника
      store = c.participants[1] ?? null;
    }

    // call.ringing без собеседника — ранний бесполезный сигнал, пропускаем.
    if (isRinging && !external) return null;

    const isIncoming = c.direction !== "outgoing";
    const answered = !!c.answeredAt;
    const durationSeconds = typeof c.duration === "number" ? c.duration : c.voicemail?.duration ?? null;
    const hasVoicemail = !!c.voicemail && !!(c.voicemail.url || c.voicemail.duration);

    // Пропущенный входящий: QUO присылает status="completed" даже для НЕотвеченных звонков,
    // поэтому missed определяем по answeredAt=null + нулевой длительности (а не по строке status).
    // Голосовую почту (voicemail) missed'ом не считаем — это отдельный тип с сообщением.
    let status = mapCallStatus(c.status);
    if (!isRinging && isIncoming && !answered && !hasVoicemail && (durationSeconds ?? 0) === 0) {
      status = "MISSED";
    }

    // Номер собеседника может отсутствовать (пропущенный без участников). НЕ выдумываем его:
    // сохраняем как непривязанный (external=""), ingest оставит orderId=null.
    return {
      ...base,
      kind: isRinging ? "call_ringing" : "call",
      type: hasVoicemail ? "VOICEMAIL" : "CALL",
      direction: c.direction === "outgoing" ? "OUTBOUND" : "INBOUND",
      status,
      externalPhone: external ?? "",
      storePhone: store,
      durationSeconds,
      recordingUrl: c.voicemail?.url ?? null,
      occurredAt: c.completedAt ?? c.createdAt ?? env.createdAt ?? new Date().toISOString(),
    };
  }

  // ── Обогащение: запись / транскрипт / summary (привязка по resourceId=callId в ingest) ──
  if (eventType === "call.recording.completed") {
    const r = obj as QuoRecordingObject & { callId?: string };
    return { ...base, kind: "recording", type: "CALL", direction: "INBOUND", status: "COMPLETED", resourceId: r.callId ?? base.resourceId, externalPhone: "", storePhone: null, recordingUrl: r.url ?? null, durationSeconds: typeof r.duration === "number" ? r.duration : null, occurredAt: r.startTime ?? env.createdAt ?? new Date().toISOString() };
  }
  if (eventType === "call.transcript.completed") {
    const t = obj as QuoTranscriptObject;
    return { ...base, kind: "transcript", type: "CALL", direction: "INBOUND", status: "COMPLETED", resourceId: t.callId ?? base.resourceId, externalPhone: "", storePhone: null, transcript: transcriptToText(t), occurredAt: env.createdAt ?? new Date().toISOString() };
  }
  if (eventType === "call.summary.completed") {
    const s = obj as QuoSummaryObject;
    return { ...base, kind: "summary", type: "CALL", direction: "INBOUND", status: "COMPLETED", resourceId: s.callId ?? base.resourceId, externalPhone: "", storePhone: null, summary: joinText(s.summary), occurredAt: env.createdAt ?? new Date().toISOString() };
  }

  return null; // неизвестный/неподдерживаемый тип
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
