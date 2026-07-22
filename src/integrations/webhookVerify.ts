import "server-only";
import crypto from "crypto";

/**
 * Generic HMAC-SHA256 проверка подписи вебхука по СЫРОМУ телу.
 * Общая утилита для адаптеров, чей провайдер использует base64(HMAC-SHA256(rawBody, secret))
 * (Shopify, WooCommerce). Сравнение — constant-time. Shopify исторически использует свою
 * функцию (`shopify/webhookAuth.ts`) — она сохранена; новые адаптеры используют эту.
 */
export function verifyHmacBase64(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
