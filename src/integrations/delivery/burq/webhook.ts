/**
 * Проверка подписи и разбор Burq-webhook. Подпись — Stripe-подобная HMAC-SHA256:
 * заголовок `Burq-Signature: t=<unix>,v1=<hex>`, подписывается строка `${t}.${rawBody}`.
 * Сравнение — константное по времени; проверяется окно допуска по времени (replay-защита).
 *
 * parseBurqWebhook НЕ сохраняет полный payload/PII — только нужные поля события.
 */
import crypto from "node:crypto";
import type { BurqWebhookEvent } from "./types";

export type SignatureVerification = { valid: boolean; reason?: string };

/** Разбирает заголовок `t=...,v1=...`. */
function parseSignatureHeader(header: string): { t: string | null; v1: string | null } {
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") t = v?.trim() ?? null;
    if (k?.trim() === "v1") v1 = v?.trim() ?? null;
  }
  return { t, v1 };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Проверяет подпись webhook. `toleranceSec` — допустимый разброс времени (по умолчанию 300с).
 * `nowMs` инъектируется для тестов.
 */
export function verifyBurqSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  nowMs: number = Date.now()
): SignatureVerification {
  if (!signatureHeader) return { valid: false, reason: "missing_signature" };
  if (!secret) return { valid: false, reason: "missing_secret" };
  const { t, v1 } = parseSignatureHeader(signatureHeader);
  if (!t || !v1) return { valid: false, reason: "malformed_header" };

  const tsSec = Number(t);
  if (!Number.isFinite(tsSec)) return { valid: false, reason: "bad_timestamp" };
  if (Math.abs(nowMs / 1000 - tsSec) > toleranceSec) return { valid: false, reason: "timestamp_out_of_tolerance" };

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  if (!timingSafeEqualHex(expected, v1)) return { valid: false, reason: "signature_mismatch" };
  return { valid: true };
}

/**
 * Envelope Burq webhook: { object:"event", type, data: <Delivery resource> }.
 * data (Delivery) содержит: id (d_...), external_order_ref (наш ref), status, provider,
 * provider_id, total_amount_due, fee, currency, quote_id, courier, tracking_url, updated_at.
 */
type BurqDeliveryData = {
  id?: string;
  external_order_ref?: string | null;
  status?: string;
  // ФАКТ (PAR-1308): в webhook `provider` — ОБЪЕКТ { id: "dsp_...", name: "Uber" }; в GET —
  // строка "Uber". `provider.id` (dsp_) — СТАБИЛЬНЫЙ id провайдера; top-level `provider_id`
  // (del_) — покоштучный id доставки. Обрабатываем обе формы.
  provider?: string | { id?: string | null; name?: string | null } | null;
  provider_id?: string | null;
  total_amount_due?: number | null;
  fee?: number | null;
  currency?: string | null;
  quote_id?: string | null;
  tracking_url?: string | null;
  updated_at?: string;
  created_at?: string;
  courier?: { name?: string | null; phone_number_for_customer?: string | null; phone_number?: string | null } | null;
  proof_of_delivery_image_urls?: string[] | null;
  signature_image_url?: string | null;
};

/** Имя провайдера из provider (строка или { name }). */
export function extractProviderName(provider: BurqDeliveryData["provider"]): string | null {
  if (typeof provider === "string") return provider;
  return provider?.name ?? null;
}
/** Стабильный id провайдера (provider.id = dsp_...), если provider — объект. */
export function extractProviderStableId(provider: BurqDeliveryData["provider"]): string | null {
  if (provider && typeof provider === "object") return provider.id ?? null;
  return null;
}
type BurqWebhookPayload = { object?: string; type?: string; event_id?: string; created_at?: string; data?: BurqDeliveryData | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Разбирает уже проверенный webhook в нормализованное событие (без сохранения полного payload). */
export function parseBurqWebhook(payload: unknown): BurqWebhookEvent | null {
  const p = (payload ?? {}) as BurqWebhookPayload;
  const data = p.data ?? {};
  const deliveryExternalId = data.id ?? null;
  const rawStatus = data.status ?? null;
  // Матчить нашу Delivery можно по external_order_ref (стабильный НАШ ref) ИЛИ delivery id.
  if ((!deliveryExternalId && !data.external_order_ref) || !rawStatus) return null;
  const tsRaw = data.updated_at ?? data.created_at ?? p.created_at;
  const occurredAt = tsRaw ? new Date(tsRaw) : null;
  return {
    deliveryExternalId: deliveryExternalId ?? "",
    externalOrderRef: data.external_order_ref ?? null,
    rawStatus,
    providerEventId: p.event_id ?? null, // envelope обычно без event_id → дедуп по ref+status+time
    occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
    courierName: data.courier?.name ?? null,
    courierPhone: data.courier?.phone_number_for_customer ?? data.courier?.phone_number ?? null,
    trackingUrl: data.tracking_url ?? null,
    provider: extractProviderName(data.provider), // "Uber" (строка или provider.name)
    providerId: extractProviderStableId(data.provider), // стабильный dsp_... (не покоштучный del_)
    totalAmountDueCents: num(data.total_amount_due),
    feeCents: num(data.fee),
    currency: data.currency ?? null,
    quoteId: data.quote_id ?? null,
    // POD URL сюда НЕ кладём (событие идёт в outbox) — их подтягивает refetchPodForDelivery через GET.
  };
}
