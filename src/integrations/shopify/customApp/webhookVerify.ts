import "server-only";
/**
 * Server-обёртка проверки Shopify webhook для нескольких независимых магазинов.
 *
 * Алгоритм (безопасный выбор Site ДО доверия телу):
 *  1) raw body уже получен вызывающим (route);
 *  2) X-Shopify-Shop-Domain — ТОЛЬКО кандидат, нормализуем;
 *  3) находим Site по normalizedShopDomain;
 *  4) берём Client Secret именно этого Site (+ previous в окне ротации), расшифровываем;
 *  5) HMAC-SHA256 base64 + timingSafeEqual;
 *  6) магазину доверяем ТОЛЬКО после успешной проверки.
 * shop domain из тела НЕ используется до проверки подписи.
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/secretBox";
import { normalizeMyshopifyDomain } from "./domain";
import { secretsForVerification, verifyWebhookHmac } from "./webhookVerifyLogic";

export type WebhookVerifyResult =
  | { ok: true; siteId: string; webhookId: string | null; topic: string | null }
  | { ok: false; reason: "no_shop_header" | "unknown_shop" | "no_secret" | "bad_signature" };

function header(headers: Record<string, string | null | undefined>, name: string): string | null {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key] ?? null;
  }
  return null;
}

export async function verifyShopifyCustomAppWebhook(input: {
  rawBody: string;
  headers: Record<string, string | null | undefined>;
  now?: Date;
}): Promise<WebhookVerifyResult> {
  const hmac = header(input.headers, "x-shopify-hmac-sha256");
  const shopCandidate = header(input.headers, "x-shopify-shop-domain");
  if (!shopCandidate) return { ok: false, reason: "no_shop_header" };

  const domain = normalizeMyshopifyDomain(shopCandidate);
  const site = await prisma.site.findFirst({
    where: { platform: "SHOPIFY", normalizedShopDomain: domain, authMode: "CUSTOM_APP" },
    select: {
      id: true,
      clientSecretEncrypted: true,
      previousClientSecretEncrypted: true,
      previousSecretValidUntil: true,
    },
  });
  if (!site) return { ok: false, reason: "unknown_shop" };
  if (!site.clientSecretEncrypted) return { ok: false, reason: "no_secret" };

  const secrets = secretsForVerification({
    currentSecret: decryptSecret(site.clientSecretEncrypted),
    previousSecret: site.previousClientSecretEncrypted ? decryptSecret(site.previousClientSecretEncrypted) : null,
    previousValidUntil: site.previousSecretValidUntil,
    now: input.now,
  });

  if (!verifyWebhookHmac(input.rawBody, hmac, secrets)) {
    return { ok: false, reason: "bad_signature" };
  }

  return {
    ok: true,
    siteId: site.id,
    webhookId: header(input.headers, "x-shopify-webhook-id"),
    topic: header(input.headers, "x-shopify-topic"),
  };
}
