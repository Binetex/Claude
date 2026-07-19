import "server-only";
/**
 * Приём Burq webhook: verify подпись → parse → enqueue в outbox (`burq.webhook.received`).
 * Тело парсится ТОЛЬКО после успешной проверки подписи. Async-обработка — worker'ом.
 * Секрет читается из env (BURQ_WEBHOOK_SECRET) и НИКОГДА не логируется.
 */
import { prisma } from "@/lib/db";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { getBurqWebhookSecret } from "./settings";
import { verifyBurqSignature, parseBurqWebhook } from "./webhook";
import { BURQ_WEBHOOK_EVENT } from "./webhookHandler";

const SIGNATURE_HEADER = "burq-signature";

export type IntakeResult = { status: number; body: unknown };

export async function intakeBurqWebhook(input: { rawBody: string; headers: Record<string, string> }): Promise<IntakeResult> {
  // Master gate: при выключенном runtime — быстрый безопасный ответ БЕЗ verify/parse/enqueue.
  if (!isBurqRuntimeEnabled()) return { status: 503, body: { error: "burq runtime disabled" } };

  const secret = (await getBurqWebhookSecret()) ?? "";
  if (!secret) {
    console.error("[burq] webhook signing secret не задан (BurqSettings/env) — вебхук отклонён");
    return { status: 503, body: { error: "webhook not configured" } };
  }

  const signature = input.headers[SIGNATURE_HEADER] ?? input.headers[SIGNATURE_HEADER.toLowerCase()] ?? null;
  const verification = verifyBurqSignature(input.rawBody, signature, secret);
  if (!verification.valid) {
    console.warn(`[burq] невалидная подпись вебхука: ${verification.reason}`);
    return { status: 401, body: { error: "invalid signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }

  const event = parseBurqWebhook(payload);
  if (!event) return { status: 202, body: { received: true, ignored: "unrecognized_event" } };

  // Дедуп на уровне outbox: стабильный ключ по НАШЕМУ external_order_ref (или delivery id) +
  // providerEventId (если есть) ИЛИ статус+время. Матчинг Delivery — по external_order_ref.
  const repo = new PrismaOutboxRepository(prisma);
  const refKey = event.externalOrderRef || event.deliveryExternalId;
  const dedup = event.providerEventId ?? `${event.rawStatus}:${event.occurredAt?.toISOString() ?? "na"}`;
  await repo.enqueue({
    eventType: BURQ_WEBHOOK_EVENT,
    aggregateType: "delivery",
    aggregateId: refKey,
    payload: event,
    idempotencyKey: `burq:webhook:${refKey}:${dedup}`,
  });

  return { status: 200, body: { received: true } };
}
