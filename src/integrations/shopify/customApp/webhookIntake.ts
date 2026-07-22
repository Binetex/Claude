import "server-only";
/**
 * Приём Shopify Custom App webhook: безопасная проверка подписи per-Site, дедуп по
 * X-Shopify-Webhook-Id, быстрая публикация в persistent outbox, 200. Тело парсится ТОЛЬКО
 * после успешной проверки подписи. Дальнейшая обработка — отдельным worker'ом (async),
 * чтобы медленный импорт не приводил к повторной доставке.
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { verifyShopifyCustomAppWebhook } from "./webhookVerify";

export type IntakeResult = { handled: boolean; status: number; body: Record<string, unknown> };

export async function intakeShopifyCustomAppWebhook(input: {
  rawBody: string;
  headers: Record<string, string | null | undefined>;
}): Promise<IntakeResult> {
  const v = await verifyShopifyCustomAppWebhook({ rawBody: input.rawBody, headers: input.headers });
  if (!v.ok) {
    // Неизвестный магазин → возможно, это legacy global-OAuth; сигналим route на fallback.
    if (v.reason === "unknown_shop") return { handled: false, status: 0, body: {} };
    // Плохая подпись / нет секрета — не доверяем, не парсим тело.
    return { handled: true, status: 401, body: { error: v.reason } };
  }

  // Только теперь — парсинг тела (после успешной проверки подписи).
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { handled: true, status: 400, body: { error: "invalid_json" } };
  }

  // Дедупликация: по webhook-id (или хэшу тела, если id не пришёл).
  const webhookId = v.webhookId ?? crypto.createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32);
  const idempotencyKey = `shopify:webhook:${v.siteId}:${webhookId}`;

  // Быстрая durable-публикация; enqueue идемпотентен → повторная доставка не создаёт дубль.
  const repo = new PrismaOutboxRepository(prisma);
  await repo.enqueue({
    eventType: "shopify.webhook.received",
    aggregateType: "order",
    aggregateId: v.siteId,
    payload: { siteId: v.siteId, topic: v.topic, webhookId, shopify: payload },
    idempotencyKey,
  });

  return { handled: true, status: 200, body: { received: true } };
}
