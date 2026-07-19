import "server-only";
/**
 * Применение статуса доставки из webhook / polling / ручного действия. Единая точка:
 *  - дедуп события по (deliveryId, providerEventId);
 *  - anti-rollback (shouldApplyDeliveryUpdate): stale/terminal/manual-lock не перетираются;
 *  - обновление Delivery + маппинг Order.orderStatus;
 *  - `attempting reroute` → PROBLEM (Delivery+Order), без publish/авто-ретрая;
 *  - DELIVERED → публикует order.delivery.completed (идемпотентно через outbox).
 *
 * Полный payload/PII не сохраняем — только нормализованные поля события.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { DeliveryProviderStatus, DeliveryEventSource } from "@/generated/prisma/enums";
import { mapBurqStatus, orderStatusForDelivery, isDeliveredStatus } from "./statusMap";
import { shouldApplyDeliveryUpdate } from "./reconcile";
import { decideCostUpdate } from "./costCapture";
import { recomputeEstimatedProfit } from "@/modules/pricing/service";

export type StatusUpdateInput = {
  /** Идентификация доставки (по приоритету): deliveryId (ручное) → externalOrderRef (webhook,
   *  стабильный НАШ ref) → externalDeliveryId (Burq order id, у нас = Delivery.externalDeliveryId). */
  externalDeliveryId?: string;
  externalOrderRef?: string | null;
  deliveryId?: string;
  /** Сырой Burq-статус (для webhook/polling) ИЛИ уже нормализованный (для manual). */
  rawStatus?: string;
  normalizedStatus?: DeliveryProviderStatus;
  providerEventId?: string | null;
  occurredAt?: Date | null;
  source: DeliveryEventSource;
  manual?: boolean;
  userId?: string | null;
  safeReason?: string | null;
  courierName?: string | null;
  courierPhone?: string | null;
  trackingUrl?: string | null;
  // Стоимость/провайдер доставки из Burq latest_delivery (Path A). Суммы — в ЦЕНТАХ.
  provider?: string | null;
  providerId?: string | null;
  totalAmountDueCents?: number | null;
  feeCents?: number | null;
  currency?: string | null;
  quoteId?: string | null;
};

export type StatusUpdateResult =
  | { outcome: "applied"; status: DeliveryProviderStatus; delivered: boolean }
  | { outcome: "duplicate" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "delivery_not_found" };

/** Публикатор order.delivery.completed (обёртка над outbox publishEvent). Идемпотентность —
 *  по конкретной Delivery (`order.delivery.completed:{deliveryId}`). */
export type PublishCompleted = (args: { orderId: string; deliveryId: string }) => Promise<void>;

export async function applyDeliveryStatusUpdate(
  prisma: PrismaClient,
  publishCompleted: PublishCompleted,
  input: StatusUpdateInput
): Promise<StatusUpdateResult> {
  const delivery = input.deliveryId
    ? await prisma.delivery.findUnique({ where: { id: input.deliveryId } })
    : input.externalOrderRef
      ? await prisma.delivery.findFirst({ where: { externalOrderRef: input.externalOrderRef }, orderBy: { createdAt: "desc" } })
      : input.externalDeliveryId
        ? await prisma.delivery.findFirst({ where: { externalDeliveryId: input.externalDeliveryId }, orderBy: { createdAt: "desc" } })
        : null;
  if (!delivery) return { outcome: "delivery_not_found" };

  const normalized = input.normalizedStatus ?? mapBurqStatus(input.rawStatus);

  // Дедуп webhook-события по providerEventId.
  if (input.providerEventId) {
    const dup = await prisma.deliveryStatusEvent.findUnique({
      where: { deliveryId_providerEventId: { deliveryId: delivery.id, providerEventId: input.providerEventId } },
    });
    if (dup) return { outcome: "duplicate" };
  }

  const decision = shouldApplyDeliveryUpdate(
    { status: delivery.status, providerEventAt: delivery.providerEventAt, resolutionSource: delivery.resolutionSource },
    { status: normalized, providerEventAt: input.occurredAt ?? null, manual: input.manual }
  );

  // Событие в историю пишем всегда (аудит), даже если не применяем.
  await prisma.deliveryStatusEvent.create({
    data: {
      deliveryId: delivery.id,
      providerEventId: input.providerEventId ?? null,
      rawStatus: input.rawStatus ?? null,
      normalizedStatus: normalized,
      source: input.source,
      userId: input.userId ?? null,
      previousStatus: delivery.status,
      newStatus: decision.apply ? normalized : delivery.status,
      safeReason: input.safeReason ?? (decision.apply ? null : decision.reason),
      occurredAt: input.occurredAt ?? null,
    },
  });

  if (!decision.apply) return { outcome: "skipped", reason: decision.reason };

  const delivered = isDeliveredStatus(normalized);
  const now = new Date();
  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      status: normalized,
      rawProviderStatus: input.rawStatus ?? delivery.rawProviderStatus,
      providerEventAt: input.occurredAt ?? now,
      isDraft: normalized === "DRAFT_PENDING" || normalized === "DRAFT_CREATED",
      courierName: input.courierName ?? undefined,
      courierPhone: input.courierPhone ?? undefined,
      trackingUrl: input.trackingUrl ?? undefined,
      deliveredAt: delivered ? now : undefined,
      resolutionSource: input.manual ? "MANUAL_ADMIN" : input.source,
      resolvedByUserId: input.userId ?? undefined,
      lastWebhookAt: input.source === "BURQ_WEBHOOK" ? now : undefined,
      lastStatusCheckAt: input.source === "POLLING" ? now : undefined,
    },
  });

  // Order: статус по маппингу (null — не трогаем) + синхронизация tracking-ссылки в order-level
  // поле Order.trackingUrl (его читает карточка «Статус доставки»).
  const orderStatus = orderStatusForDelivery(normalized);
  const orderData: { orderStatus?: NonNullable<ReturnType<typeof orderStatusForDelivery>>; trackingUrl?: string } = {};
  if (orderStatus) orderData.orderStatus = orderStatus;
  if (input.trackingUrl) orderData.trackingUrl = input.trackingUrl;
  if (Object.keys(orderData).length > 0) {
    await prisma.order.update({ where: { id: delivery.orderId }, data: orderData });
  }

  // Захват фактической стоимости доставки Uber (Path A). Best-effort: сбой стоимости НЕ ломает
  // статус/delivered — цену подхватит следующий webhook. Отсутствие суммы старое НЕ обнуляет.
  try {
    const costDecision = decideCostUpdate(
      { finalCostUpdatedAt: delivery.finalCostUpdatedAt },
      {
        provider: input.provider ?? null,
        providerId: input.providerId ?? null,
        totalAmountDueCents: input.totalAmountDueCents ?? null,
        feeCents: input.feeCents ?? null,
        currency: input.currency ?? null,
        quoteId: input.quoteId ?? null,
        occurredAt: input.occurredAt ?? null,
      }
    );
    if (costDecision.apply) {
      await prisma.$transaction(async (tx) => {
        await tx.delivery.update({
          where: { id: delivery.id },
          data: {
            finalCost: new Prisma.Decimal(costDecision.dollars),
            finalCostUpdatedAt: now,
            costSource: "BURQ_FINAL",
            currency: input.currency ?? undefined,
            quoteId: input.quoteId ?? undefined,
            providerName: input.provider ?? undefined,
            providerExternalId: input.providerId ?? undefined,
          },
        });
        await tx.order.update({ where: { id: delivery.orderId }, data: { deliveryActualCost: new Prisma.Decimal(costDecision.dollars) } });
        await recomputeEstimatedProfit(tx, delivery.orderId);
      });
    }
  } catch (err) {
    console.error(`[burq] cost capture failed for delivery ${delivery.id}:`, err instanceof Error ? err.message : String(err));
  }

  // Публикуем completed ТОЛЬКО на DELIVERED (идемпотентно на стороне outbox, ключ по deliveryId).
  if (delivered) await publishCompleted({ orderId: delivery.orderId, deliveryId: delivery.id });

  return { outcome: "applied", status: normalized, delivered };
}
