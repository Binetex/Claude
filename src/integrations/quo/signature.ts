/**
 * Верификация подписи webhook QUO (ex-OpenPhone). Заголовок:
 *   openphone-signature: hmac;1;<timestampMs>;<base64signature>
 * Подпись = base64( HMAC_SHA256( base64decode(signingKey), `${timestampMs}.${rawBody}` ) ).
 *
 * ВАЖНО: считаем по СЫРОМУ телу запроса (не по повторно сериализованному JSON). Сравнение —
 * константное по времени. Есть защита от слишком старого timestamp (replay).
 * Чистый модуль (node:crypto) — тестируется напрямую, секреты не логируются.
 */
import crypto from "node:crypto";

export type QuoSignatureResult = { valid: boolean; reason?: string };

/** Разбор `hmac;1;<ts>;<sig>`. */
function parseHeader(header: string): { scheme: string; version: string; timestamp: string; signature: string } | null {
  const parts = header.split(";");
  if (parts.length !== 4) return null;
  const [scheme, version, timestamp, signature] = parts.map((p) => p.trim());
  if (!scheme || !version || !timestamp || !signature) return null;
  return { scheme, version, timestamp, signature };
}

function timingSafeEqualB64(a: string, b: string): boolean {
  const ba = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export type VerifyQuoOptions = {
  /** Допустимый разброс времени (мс) для защиты от replay. По умолчанию 5 минут. */
  toleranceMs?: number;
  /** «Сейчас» в мс (инъекция в тестах). */
  nowMs?: number;
};

/**
 * Проверяет подпись. `rawBody` — ТОЧНО тело запроса как получено. `signingKeyBase64` — ключ
 * webhook из QUO (base64). Возвращает {valid} + причину при отказе (без утечки секретов).
 */
export function verifyQuoSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  signingKeyBase64: string | null | undefined,
  opts: VerifyQuoOptions = {}
): QuoSignatureResult {
  if (!signatureHeader) return { valid: false, reason: "missing_signature" };
  if (!signingKeyBase64) return { valid: false, reason: "missing_signing_key" };

  const parsed = parseHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: "malformed_header" };
  if (parsed.scheme !== "hmac") return { valid: false, reason: "unsupported_scheme" };

  const tsMs = Number(parsed.timestamp);
  if (!Number.isFinite(tsMs)) return { valid: false, reason: "bad_timestamp" };

  // Replay-защита: слишком старый/из будущего timestamp отклоняем.
  const toleranceMs = opts.toleranceMs ?? 5 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();
  if (Math.abs(nowMs - tsMs) > toleranceMs) return { valid: false, reason: "timestamp_out_of_tolerance" };

  let key: Buffer;
  try {
    key = Buffer.from(signingKeyBase64, "base64");
    if (key.length === 0) return { valid: false, reason: "bad_signing_key" };
  } catch {
    return { valid: false, reason: "bad_signing_key" };
  }

  const expected = crypto.createHmac("sha256", key).update(`${parsed.timestamp}.${rawBody}`).digest("base64");
  if (!timingSafeEqualB64(expected, parsed.signature)) return { valid: false, reason: "signature_mismatch" };
  return { valid: true };
}
