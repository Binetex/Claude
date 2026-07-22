/**
 * Типы QUO (ex-OpenPhone). ВСЕ провайдер-специфичные детали (имена полей, event types) живут
 * только в adapter-слое src/integrations/quo/. Контракт выверен по официальной документации
 * (api.openphone.com/v1). Не импортировать эти типы за пределами adapter/ingest.
 */

// ─── Сырые wire-объекты QUO ───
export type QuoMessageObject = {
  id?: string; // AC…
  object?: "message";
  from?: string;
  to?: string[] | string;
  direction?: "incoming" | "outgoing";
  body?: string | null;
  text?: string | null;
  media?: { url: string; type?: string }[] | null;
  status?: string; // queued|sent|delivered|undelivered|received
  createdAt?: string;
  userId?: string | null;
  phoneNumberId?: string | null;
  conversationId?: string | null;
};

export type QuoCallObject = {
  id?: string; // AC…
  object?: "call";
  from?: string;
  to?: string;
  direction?: "incoming" | "outgoing";
  status?: string; // completed|missed|no-answer|answered|…
  participants?: string[];
  voicemail?: { url?: string; duration?: number } | null;
  duration?: number | null;
  createdAt?: string;
  answeredAt?: string | null;
  completedAt?: string | null;
  userId?: string | null;
  answeredBy?: string | null;
  initiatedBy?: string | null;
  phoneNumberId?: string | null;
  conversationId?: string | null;
};

export type QuoRecordingObject = { id?: string; url?: string; type?: string | null; duration?: number | null; startTime?: string | null; status?: string };
export type QuoTranscriptDialogueSegment = { start?: number; end?: number; userId?: string | null; content?: string; identifier?: string };
export type QuoTranscriptObject = { callId?: string; dialogue?: QuoTranscriptDialogueSegment[]; status?: string; text?: string | null };
export type QuoSummaryObject = { callId?: string; summary?: string[] | string | null; nextSteps?: string[] | null; status?: string };

/** Envelope любого webhook QUO. */
export type QuoWebhookEnvelope = {
  id?: string; // EV…
  object?: "event";
  apiVersion?: string;
  createdAt?: string;
  type?: string; // message.received | call.completed | …
  data?: { object?: unknown } | null;
};

// ─── Нормализованное внутреннее событие (выход envelope-парсера) ───
export type NormalizedCommType = "SMS" | "CALL" | "VOICEMAIL";
export type NormalizedCommDirection = "INBOUND" | "OUTBOUND";
export type NormalizedCommStatus = "PENDING" | "SENT" | "DELIVERED" | "RECEIVED" | "COMPLETED" | "MISSED" | "FAILED";

/**
 * Что несёт событие: `message`/`call` — новая коммуникация; `recording`/`transcript`/`summary` —
 * ОБОГАЩЕНИЕ существующего звонка (attach по resourceId в ingest, Phase 3); `call_ringing` —
 * ранний сигнал (ingest может проигнорировать/обновить).
 */
export type NormalizedQuoEventKind = "message" | "call" | "call_ringing" | "recording" | "transcript" | "summary";

export type NormalizedQuoEvent = {
  providerEventId: string; // EV… (идемпотентность)
  eventType: string; // сырой тип QUO
  kind: NormalizedQuoEventKind;
  type: NormalizedCommType;
  direction: NormalizedCommDirection;
  status: NormalizedCommStatus;
  resourceId: string | null; // AC… (message/call id)
  conversationId: string | null;
  userId: string | null; // US…
  phoneNumberId: string | null; // PN…
  externalPhone: string; // номер собеседника (как пришёл)
  storePhone: string | null; // номер магазина
  messageText: string | null;
  durationSeconds: number | null;
  media: { url: string; type: string | null }[] | null;
  recordingUrl: string | null;
  transcript: string | null;
  summary: string | null;
  occurredAt: string; // ISO
};

// ─── Результат отправки SMS ───
export type QuoSendResult = {
  id: string; // AC…
  status: string; // queued|sent|…
  conversationId: string | null;
  from: string | null;
  to: string[];
};
