import "server-only";
import type { WebhookAdapter, WebhookInput, WebhookVerification } from "@/integrations/types";
import { verifyHmacBase64 } from "@/integrations/webhookVerify";

/**
 * Проверка вебхуков WooCommerce. Woo подписывает тело заголовком
 * `x-wc-webhook-signature` = base64(HMAC-SHA256(rawBody, secret)). Идентификатор события —
 * `x-wc-webhook-id` (или `id` из тела как fallback) для дедупликации.
 *
 * Реальный приём Woo-заказов ещё не подключён (skeleton, этап 2) — но проверка подписи
 * уже корректна и покрыта тестами, чтобы приём был безопасным с первого дня.
 */
function header(input: WebhookInput, name: string): string | null {
  // Регистронезависимый поиск заголовка (см. shopify/webhookAdapter.header).
  const target = name.toLowerCase();
  for (const key of Object.keys(input.headers)) {
    if (key.toLowerCase() === target) return input.headers[key] ?? null;
  }
  return null;
}

export const wooCommerceWebhookAdapter: WebhookAdapter = {
  platform: "WOOCOMMERCE",
  verify(input: WebhookInput): WebhookVerification {
    const sig = header(input, "x-wc-webhook-signature");
    if (!sig) return { ok: false, reason: "missing_signature" };
    if (!input.secret) return { ok: false, reason: "no_secret" };
    return verifyHmacBase64(input.rawBody, sig, input.secret)
      ? { ok: true }
      : { ok: false, reason: "invalid_signature" };
  },
  extractEventId(input: WebhookInput): string | null {
    const fromHeader = header(input, "x-wc-webhook-id");
    if (fromHeader) return fromHeader;
    try {
      const body = JSON.parse(input.rawBody) as { id?: string | number };
      return body?.id != null ? String(body.id) : null;
    } catch {
      return null;
    }
  },
};
