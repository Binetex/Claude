import "server-only";
/**
 * Ручное разрешение проблемной доставки. Доступно ЛЮБОМУ аутентифицированному сотруднику
 * (не только OWNER) — проверка аутентификации на вызывающей стороне (server action).
 *
 * ВАЖНО: ручные решения НЕ рассылают уведомления (передаём no-op publisher) и НЕ
 * перетираются поздними webhook (anti-rollback manual-lock в reconcile). Полный payload/PII
 * не сохраняем — только машинный safeReason.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { applyDeliveryStatusUpdate, type StatusUpdateResult } from "./statusIngest";
import { makeCompletedPublisher } from "./webhookHandler";

export type ManualDecision = "mark_delivered" | "mark_cancelled" | "record_refund" | "leave_problem";

const noopPublish = async () => {};

export async function resolveDeliveryManually(
  prisma: PrismaClient,
  input: { deliveryId: string; decision: ManualDecision; userId: string; safeReason?: string | null }
): Promise<StatusUpdateResult | { outcome: "recorded" }> {
  const { deliveryId, decision, userId } = input;

  if (decision === "mark_delivered") {
    // Ручное подтверждение доставки: Delivery+Order → DELIVERED, сохраняем userId+время,
    // публикуем order.delivery.completed В OUTBOX (fan-out — существующим consumer'ом позже;
    // прямых SMS из server action нет). Идемпотентность — по deliveryId.
    const publish = makeCompletedPublisher(prisma);
    return applyDeliveryStatusUpdate(prisma, publish, {
      deliveryId,
      normalizedStatus: "DELIVERED",
      source: "MANUAL_ADMIN",
      manual: true,
      userId,
      safeReason: input.safeReason ?? "manual_mark_delivered",
    });
  }

  if (decision === "mark_cancelled") {
    const res = await applyDeliveryStatusUpdate(prisma, noopPublish, {
      deliveryId,
      normalizedStatus: "CANCELLED",
      source: "MANUAL_ADMIN",
      manual: true,
      userId,
      safeReason: input.safeReason ?? "manual_mark_cancelled",
    });
    await prisma.delivery.update({ where: { id: deliveryId }, data: { cancellationReason: "MANUAL_ADMIN", cancelledAt: new Date() } });
    return res;
  }

  if (decision === "record_refund") {
    // Возврат — событие в историю + пометка заказа REFUNDED; статус доставки не трогаем.
    const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { id: true, orderId: true, status: true } });
    if (!delivery) return { outcome: "delivery_not_found" };
    await prisma.deliveryStatusEvent.create({
      data: {
        deliveryId,
        normalizedStatus: delivery.status,
        source: "MANUAL_ADMIN",
        userId,
        previousStatus: delivery.status,
        newStatus: delivery.status,
        safeReason: input.safeReason ?? "manual_refund_recorded",
      },
    });
    await prisma.order.update({ where: { id: delivery.orderId }, data: { paymentStatus: "REFUNDED" } });
    return { outcome: "recorded" };
  }

  // leave_problem — фиксируем решение оператора в истории, статус остаётся PROBLEM.
  const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { status: true } });
  await prisma.deliveryStatusEvent.create({
    data: {
      deliveryId,
      normalizedStatus: delivery?.status ?? "PROBLEM",
      source: "MANUAL_ADMIN",
      userId,
      safeReason: input.safeReason ?? "manual_leave_problem",
    },
  });
  return { outcome: "recorded" };
}
