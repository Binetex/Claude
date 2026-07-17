import "server-only";
import type { WebhookAdapter, WebhookInput, WebhookVerification } from "@/integrations/types";
import { verifyHmacBase64 } from "@/integrations/webhookVerify";

/**
 * Shopify как реализация общего `WebhookAdapter`. Подпись — `x-shopify-hmac-sha256`
 * = base64(HMAC-SHA256(rawBody, app secret)). Идентификатор события для дедупликации —
 * `x-shopify-webhook-id` (Shopify гарантирует его уникальность на доставку).
 *
 * Существующий `shopify/webhookAuth.verifyWebhookHmac` и рабочий route сохранены как есть —
 * этот адаптер даёт единый контракт для реестра и переносится в route позже (см. backlog).
 */
function header(input: WebhookInput, name: string): string | null {
  return input.headers[name] ?? input.headers[name.toLowerCase()] ?? null;
}

export const shopifyWebhookAdapter: WebhookAdapter = {
  platform: "SHOPIFY",
  verify(input: WebhookInput): WebhookVerification {
    const sig = header(input, "x-shopify-hmac-sha256");
    if (!sig) return { ok: false, reason: "missing_signature" };
    if (!input.secret) return { ok: false, reason: "no_secret" };
    return verifyHmacBase64(input.rawBody, sig, input.secret)
      ? { ok: true }
      : { ok: false, reason: "invalid_signature" };
  },
  extractEventId(input: WebhookInput): string | null {
    const fromHeader = header(input, "x-shopify-webhook-id");
    if (fromHeader) return fromHeader;
    try {
      const body = JSON.parse(input.rawBody) as { id?: string | number };
      return body?.id != null ? String(body.id) : null;
    } catch {
      return null;
    }
  },
};
