import "server-only";
/**
 * Публикация trigger-событий авто-SMS из точек жизненного цикла заказа. Best-effort и
 * ИДЕМПОТЕНТНО: сбой публикации логируется, но НЕ ломает приём заказа/обновление доставки
 * (сам факт события — в durable outbox, дедуп по ключу). Вызывать ТОЛЬКО из «живых» путей:
 *  - ORDER_CREATED — строго после успешного ПЕРВОГО создания Order (не update/resync/backfill);
 *  - TRACKING_LINK_AVAILABLE — когда у заказа ВПЕРВЫЕ появился tracking-URL.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationTrigger } from "./events";

export async function publishOrderCreatedTrigger(prisma: PrismaClient, args: { orderId: string; siteId: string }): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: "ORDER_CREATED",
      occurrenceKey: args.orderId, // один заказ создаётся один раз
    });
  } catch (err) {
    console.error(`[sms] publishOrderCreatedTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function publishOrderDeliveredTrigger(prisma: PrismaClient, args: { orderId: string; deliveryId: string }): Promise<void> {
  try {
    const ord = await prisma.order.findUnique({ where: { id: args.orderId }, select: { siteId: true } });
    if (!ord) return;
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: ord.siteId,
      triggerType: "ORDER_DELIVERED",
      occurrenceKey: args.deliveryId, // одна доставленная попытка → один триггер
    });
  } catch (err) {
    console.error(`[sms] publishOrderDeliveredTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function publishTrackingAvailableTrigger(
  prisma: PrismaClient,
  args: { orderId: string; siteId: string; deliveryId: string }
): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: "TRACKING_LINK_AVAILABLE",
      occurrenceKey: args.deliveryId, // одна попытка доставки → один tracking-триггер
    });
  } catch (err) {
    console.error(`[sms] publishTrackingAvailableTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}
