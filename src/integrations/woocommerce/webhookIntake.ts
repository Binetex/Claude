import "server-only";
/**
 * Приём WooCommerce webhook для конкретного Site (endpoint /api/webhooks/woocommerce/[siteId]).
 * Порядок: найти активное подключение → проверить HMAC per-Site (secret этого Site) → только
 * потом парсить тело → дедуп по X-WC-Webhook-Delivery-ID через outbox → быстрый 200. Обработка
 * (ingest) — в worker'е, чтобы медленный импорт не приводил к повторной доставке.
 *
 * PII целиком не логируем.
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { wooCommerceWebhookAdapter } from "./webhookAdapter";
import { resolveWooWebhookSecret } from "./credentials";

export type WooIntakeResult = { status: number; body: Record<string, unknown> };

function header(headers: Record<string, string | null | undefined>, name: string): string | null {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === target) return headers[k] ?? null;
  return null;
}

export async function intakeWooWebhook(input: {
  siteId: string;
  rawBody: string;
  headers: Record<string, string | null | undefined>;
}): Promise<WooIntakeResult> {
  // Site должен существовать, быть WooCommerce и не отключённым.
  const conn = await prisma.wooCommerceConnection.findUnique({
    where: { siteId: input.siteId },
    select: { siteId: true, connStatus: true },
  });
  if (!conn || conn.connStatus === "DISCONNECTED") {
    return { status: 404, body: { error: "unknown_site" } };
  }

  // WooCommerce шлёт ping без подписи при создании подписки — отвечаем 200, не обрабатывая.
  const topic = header(input.headers, "x-wc-webhook-topic");
  const signature = header(input.headers, "x-wc-webhook-signature");
  if (!topic || !signature) {
    return { status: 200, body: { received: true, note: "ping_or_unsigned" } };
  }

  const secret = await resolveWooWebhookSecret(input.siteId);
  const verification = wooCommerceWebhookAdapter.verify({ rawBody: input.rawBody, headers: input.headers, secret });
  if (!verification.ok) {
    // Плохая подпись / нет секрета — не доверяем, тело не парсим.
    return { status: 401, body: { error: verification.reason } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  // Дедуп: delivery-id уникален на доставку; fallback — хэш тела.
  const deliveryId = header(input.headers, "x-wc-webhook-delivery-id");
  const dedupId = deliveryId ?? crypto.createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32);
  const idempotencyKey = `woo:webhook:${input.siteId}:${dedupId}`;

  const repo = new PrismaOutboxRepository(prisma);
  await repo.enqueue({
    eventType: "woo.webhook.received",
    aggregateType: "order",
    aggregateId: input.siteId,
    payload: { siteId: input.siteId, topic, deliveryId: dedupId, woo: payload },
    idempotencyKey,
  });

  return { status: 200, body: { received: true } };
}
