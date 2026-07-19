import "server-only";
/**
 * Outbox-handler `burq.webhook.received`: применяет нормализованное Burq-событие к Delivery
 * (anti-rollback, дедуп, маппинг Order-статуса, publish completed на DELIVERED).
 * Полный payload не хранится — в outbox кладём уже нормализованное событие.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishEvent } from "@/outbox/publisher";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { applyDeliveryStatusUpdate } from "./statusIngest";
import type { BurqWebhookEvent } from "./types";

export const BURQ_WEBHOOK_EVENT = "burq.webhook.received";

/**
 * Публикует order.delivery.completed идемпотентно. Ключ — по конкретной Delivery
 * (`order.delivery.completed:{deliveryId}`): каждая доставленная попытка публикует событие
 * ровно один раз; существующий consumer дедуплицирует fan-out по orderId.
 */
export function makeCompletedPublisher(prisma: PrismaClient) {
  const repo = new PrismaOutboxRepository(prisma);
  return async ({ orderId, deliveryId }: { orderId: string; deliveryId: string }) => {
    await publishEvent(repo, "order.delivery.completed", { orderId }, { idempotencyKey: `order.delivery.completed:${deliveryId}` });
  };
}

export function buildBurqWebhookHandler(prisma: PrismaClient): OutboxHandler {
  const publishCompleted = makeCompletedPublisher(prisma);
  return async (record: OutboxRecord) => {
    if (!isBurqRuntimeEnabled()) return; // master gate: не обрабатываем webhook-события
    const ev = record.payload as BurqWebhookEvent;
    // Матчим Delivery по НАШЕМУ external_order_ref; стоимость/провайдер — прямо из webhook data
    // (Delivery resource), GET не нужен.
    await applyDeliveryStatusUpdate(prisma, publishCompleted, {
      externalOrderRef: ev.externalOrderRef,
      rawStatus: ev.rawStatus,
      providerEventId: ev.providerEventId,
      occurredAt: ev.occurredAt ? new Date(ev.occurredAt) : null,
      source: "BURQ_WEBHOOK",
      courierName: ev.courierName ?? null,
      courierPhone: ev.courierPhone ?? null,
      trackingUrl: ev.trackingUrl ?? null,
      provider: ev.provider ?? null,
      providerId: ev.providerId ?? null,
      totalAmountDueCents: ev.totalAmountDueCents ?? null,
      feeCents: ev.feeCents ?? null,
      currency: ev.currency ?? null,
      quoteId: ev.quoteId ?? null,
    });
  };
}
