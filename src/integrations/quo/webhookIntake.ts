/**
 * Приём webhook QUO (тестируемое ядро, без Next Request). Порядок:
 *  1) проверить `openphone-signature` против ЛЮБОГО из signing keys (безопасная ротация);
 *  2) ТОЛЬКО после успешной подписи — распарсить тело (raw body);
 *  3) известное событие → идемпотентно поставить в outbox (durable PENDING) → быстрый 200;
 *  4) неизвестный тип → безопасно проигнорировать + залогировать (200);
 *  5) плохая/старая/отсутствующая подпись → 401 (тело не парсим).
 * Дедуп повторной доставки — по idempotencyKey `quo:webhook:{providerEventId}` (outbox не создаёт дубль).
 * Логи без PII.
 */
import { verifyQuoSignature } from "./signature";
import { parseQuoWebhook } from "./envelope";
import { maskPhone, quoLog } from "./logging";

export type QuoEnqueue = (e: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  idempotencyKey: string;
}) => Promise<{ created: boolean }>;

export type QuoIntakeDeps = {
  signingKeys: string[];
  enqueue: QuoEnqueue;
  nowMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

export type QuoIntakeResult = { status: number; body: Record<string, unknown> };

export async function intakeQuoWebhook(rawBody: string, signatureHeader: string | null | undefined, deps: QuoIntakeDeps): Promise<QuoIntakeResult> {
  const log = deps.log ?? quoLog;

  // 1) Подпись: валидна, если совпала хотя бы с одним ключом (ротация).
  let verified = false;
  let lastReason = deps.signingKeys.length ? "signature_mismatch" : "no_signing_keys";
  for (const key of deps.signingKeys) {
    const r = verifyQuoSignature(rawBody, signatureHeader, key, { nowMs: deps.nowMs });
    if (r.valid) { verified = true; break; }
    lastReason = r.reason ?? lastReason;
  }
  if (!verified) {
    log("webhook.rejected", { reason: lastReason });
    return { status: 401, body: { error: "invalid_signature" } };
  }

  // 2) Парсим тело только после успешной подписи.
  const event = parseQuoWebhook(rawBody);
  if (!event) {
    log("webhook.ignored", { reason: "unknown_or_unsupported_type" });
    return { status: 200, body: { ignored: true } }; // безопасно игнорируем неизвестный тип
  }

  // 3) Durable-постановка в outbox (идемпотентно по providerEventId) → быстрый ответ.
  const { created } = await deps.enqueue({
    eventType: "quo.webhook.received",
    aggregateType: "communication",
    aggregateId: event.providerEventId,
    payload: event,
    idempotencyKey: `quo:webhook:${event.providerEventId}`,
  });
  log("webhook.accepted", { providerEventId: event.providerEventId, eventType: event.eventType, kind: event.kind, duplicate: !created, phone: maskPhone(event.externalPhone) });
  return { status: 200, body: { received: true, duplicate: !created } };
}
