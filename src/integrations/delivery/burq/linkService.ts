import "server-only";
/**
 * Ручная привязка СУЩЕСТВУЮЩЕГО Burq order (o_...) к заказу Floremart. НЕ создаёт Burq order,
 * НЕ делает POST/DELETE в Burq — только read-only GET, чтобы сразу подтянуть текущее состояние
 * (статус, provider, tracking, стоимость Uber, POD, курьер, даты) через уже существующую логику
 * applyDeliveryStatusUpdate + refetchPodForDelivery. Дальше Delivery обновляют обычные webhook
 * (матч по external_order_ref, который мы копируем из самого Burq order).
 *
 * OrderStatus меняется ТОЛЬКО стандартным status-mapper (внутри applyDeliveryStatusUpdate);
 * PaymentStatus не трогаем. Один Burq order = один заказ Floremart (дедуп по externalDeliveryId).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";
import { getBurqRuntimeClient } from "./settings";
import { BurqApiError } from "./client";
import { mapBurqStatus } from "./statusMap";
import { applyDeliveryStatusUpdate, type PublishCompleted } from "./statusIngest";
import { refetchPodForDelivery } from "./podService";
import { RETRYABLE_DELIVERY_STATUSES } from "./retryService";

export type LinkBurqOrderInput = {
  orderId: string;
  burqOrderId: string;
  /** Пользователь подтвердил замену уже активной (не терминальной) текущей доставки. */
  replaceActive?: boolean;
};

export type LinkBurqOrderResult =
  | { outcome: "linked"; deliveryId: string; attemptNumber: number; status: DeliveryProviderStatus; delivered: boolean }
  | { outcome: "needs_confirmation"; currentDeliveryId: string; currentStatus: DeliveryProviderStatus }
  | { outcome: "already_linked_other"; orderId: string }
  | { outcome: "burq_not_found" }
  | { outcome: "order_not_found" }
  | { outcome: "invalid_id" };

/** Burq order id — формат o_<alnum>. Дешёвая валидация до сетевого вызова. `mock_…` допускается
 *  для mock-клиента (тесты / выключенный runtime). */
export function isBurqOrderId(id: string): boolean {
  return /^(o_[a-z0-9]+|mock_[a-z0-9-]+)$/i.test(id);
}

/** Статусы, из которых текущую попытку можно заменить БЕЗ подтверждения (терминально-провальные). */
const AUTO_REPLACEABLE = new Set<string>(RETRYABLE_DELIVERY_STATUSES);

export async function linkBurqOrder(
  prisma: PrismaClient,
  publishCompleted: PublishCompleted,
  input: LinkBurqOrderInput
): Promise<LinkBurqOrderResult> {
  const burqOrderId = input.burqOrderId.trim();
  if (!isBurqOrderId(burqOrderId)) return { outcome: "invalid_id" };

  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, currentFloristId: true } });
  if (!order) return { outcome: "order_not_found" };

  // Дедуп: этот Burq order уже привязан? Разрешаем ТОЛЬКО если это текущая попытка ЭТОГО заказа
  // (идемпотентный повторный pull). Любая другая привязка (другой заказ / историческая попытка) — отказ.
  const existingLink = await prisma.delivery.findFirst({
    where: { externalDeliveryId: burqOrderId },
    select: { id: true, orderId: true, isCurrentAttempt: true },
  });
  if (existingLink && !(existingLink.orderId === input.orderId && existingLink.isCurrentAttempt)) {
    return { outcome: "already_linked_other", orderId: existingLink.orderId };
  }

  // GET Burq order (read-only). 404 → заказ не найден в Burq.
  const client = await getBurqRuntimeClient();
  let burq;
  try {
    burq = await client.getOrder(burqOrderId);
  } catch (err) {
    if (err instanceof BurqApiError && err.status === 404) return { outcome: "burq_not_found" };
    throw err;
  }

  // external_order_ref из самого Burq order — по нему будущие webhook найдут эту Delivery.
  // Если Burq order создан вне Floremart и ref пуст — ставим синтетический (webhook-матч тогда
  // возможен только если Burq пришлёт этот ref; немедленный pull всё равно отработает).
  const deliveries = await prisma.delivery.findMany({
    where: { orderId: input.orderId },
    select: { id: true, attemptNumber: true, status: true, isCurrentAttempt: true, externalDeliveryId: true },
    orderBy: { attemptNumber: "asc" },
  });
  const current = deliveries.find((d) => d.isCurrentAttempt) ?? null;
  const maxAttempt = deliveries.reduce((m, d) => Math.max(m, d.attemptNumber), 0);

  let targetDeliveryId: string;
  let attemptNumber: number;

  if (current && current.externalDeliveryId === burqOrderId) {
    // Уже привязан к текущей попытке — просто перечитываем (идемпотентно).
    targetDeliveryId = current.id;
    attemptNumber = current.attemptNumber;
  } else if (current && !current.externalDeliveryId) {
    // Пустая текущая попытка (без Burq order) — используем её.
    targetDeliveryId = current.id;
    attemptNumber = current.attemptNumber;
    await prisma.delivery.update({
      where: { id: current.id },
      data: { externalDeliveryId: burqOrderId, externalOrderRef: burq.externalOrderRef ?? `${input.orderId}:a${current.attemptNumber}`, isDraft: true },
    });
  } else if (current) {
    // Есть текущая привязанная попытка. Терминально-провальную заменяем сразу; активную — только
    // после подтверждения пользователя (replaceActive).
    const autoReplace = AUTO_REPLACEABLE.has(current.status);
    if (!autoReplace && !input.replaceActive) {
      return { outcome: "needs_confirmation", currentDeliveryId: current.id, currentStatus: current.status };
    }
    attemptNumber = maxAttempt + 1;
    targetDeliveryId = await createLinkedAttempt(prisma, input.orderId, order.currentFloristId, attemptNumber, burqOrderId, burq.externalOrderRef, burq.status, current.id);
  } else {
    // Ни одной попытки — создаём первую.
    attemptNumber = maxAttempt + 1; // = 1
    targetDeliveryId = await createLinkedAttempt(prisma, input.orderId, order.currentFloristId, attemptNumber, burqOrderId, burq.externalOrderRef, burq.status, null);
  }

  // Немедленный pull через существующую логику: статус/tracking/courier/стоимость Uber/маппинг
  // OrderStatus/publish completed на delivered.
  // source=POLLING (не MANUAL_ADMIN): это синхронизация состояния из Burq, а не ручное решение —
  // не ставим manual-lock, чтобы последующие webhook продолжали обновлять Delivery.
  const applied = await applyDeliveryStatusUpdate(prisma, publishCompleted, {
    deliveryId: targetDeliveryId,
    rawStatus: burq.status,
    source: "POLLING",
    trackingUrl: burq.trackingUrl ?? null,
    courierName: burq.courierName ?? null,
    courierPhone: burq.courierPhone ?? null,
    provider: burq.provider ?? null,
    providerId: burq.providerId ?? null,
    totalAmountDueCents: burq.totalAmountDueCents ?? null,
    feeCents: burq.feeCents ?? null,
    currency: burq.currency ?? null,
    quoteId: burq.quoteId ?? null,
  });

  // POD подтягиваем тем же GET-путём (URL не попадают в outbox). Best-effort.
  try {
    await refetchPodForDelivery(prisma, targetDeliveryId);
  } catch {
    /* POD подтянется вручную кнопкой «Обновить Proof of delivery» */
  }

  const finalStatus = applied.outcome === "applied" ? applied.status : mapBurqStatus(burq.status);
  const delivered = applied.outcome === "applied" ? applied.delivered : false;
  return { outcome: "linked", deliveryId: targetDeliveryId, attemptNumber, status: finalStatus, delivered };
}

/**
 * Создаёт НОВУЮ Delivery-попытку, привязанную к существующему Burq order, БЕЗ вызова Burq.
 * Снимает isCurrentAttempt с прочих, ставит supersedes-связь при замене. Начальный статус —
 * нейтральный (mapBurqStatus от Burq); фактический прогресс применит applyDeliveryStatusUpdate.
 */
async function createLinkedAttempt(
  prisma: PrismaClient,
  orderId: string,
  floristId: string | null,
  attemptNumber: number,
  burqOrderId: string,
  externalOrderRef: string | null,
  rawStatus: string,
  supersedesDeliveryId: string | null
): Promise<string> {
  const pickupLocationId = floristId
    ? await prisma.floristPickupLocation.findUnique({ where: { floristId }, select: { id: true } }).then((r) => r?.id ?? null)
    : null;
  const normalized = mapBurqStatus(rawStatus);

  return prisma.$transaction(async (tx) => {
    await tx.delivery.updateMany({ where: { orderId, isCurrentAttempt: true }, data: { isCurrentAttempt: false } });
    const delivery = await tx.delivery.create({
      data: {
        orderId,
        provider: "BURQ",
        floristId,
        pickupLocationId,
        expectedFloristId: floristId,
        attemptNumber,
        isCurrentAttempt: true,
        externalDeliveryId: burqOrderId,
        externalOrderRef: externalOrderRef ?? `${orderId}:a${attemptNumber}`,
        isDraft: normalized === "DRAFT_PENDING" || normalized === "DRAFT_CREATED",
        status: normalized,
        rawProviderStatus: rawStatus,
        providerEventAt: null, // pull применится как forward-обновление (anti-rollback пройдёт)
        idempotencyKey: `burq:link:${orderId}:a${attemptNumber}`,
        resolutionSource: "SYSTEM", // не MANUAL_ADMIN → не запускаем manual-lock на terminal-статусах
        deliveredAt: normalized === "DELIVERED" ? new Date() : null,
        ...(supersedesDeliveryId ? { supersedesDeliveryId } : {}),
      },
    });
    if (supersedesDeliveryId) {
      await tx.delivery.update({ where: { id: supersedesDeliveryId }, data: { supersededByDeliveryId: delivery.id } });
    }
    await tx.deliveryStatusEvent.create({
      data: { deliveryId: delivery.id, rawStatus, normalizedStatus: normalized, source: "MANUAL_ADMIN", newStatus: normalized, occurredAt: new Date() },
    });
    return delivery.id;
  });
}
