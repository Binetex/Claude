import "server-only";
import crypto from "crypto";

/**
 * Проверка подписи вебхука Shopify (заголовок X-Shopify-Hmac-Sha256).
 * Считается по СЫРОМУ телу запроса (до JSON.parse) с общим секретом приложения.
 */
export function verifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
