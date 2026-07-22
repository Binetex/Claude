import "server-only";
/**
 * Ручная повторная доставка Burq. `provider_canceled`/FAILED/PROBLEM/RETURNED завершают КОНКРЕТНУЮ
 * попытку (Delivery), но НЕ клиентский заказ. Пользователь кнопкой создаёт НОВУЮ попытку: старая
 * остаётся в истории (статус не меняем), новая становится текущей со свежими данными флориста/адреса.
 *
 * Защита от дублей: claim-lock (compare-and-swap снятия isCurrentAttempt с терминальной current) +
 * partial unique index (одна isCurrentAttempt=true на заказ). Двойной клик / гонка → возвращаем
 * существующую активную попытку, второй Burq-заказ не создаём.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";
import { getBurqRuntimeClient } from "./settings";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { decideDraftEligibility } from "./eligibility";
import { buildBurqDraftRequest, DEFAULT_BURQ_DIMENSIONS } from "./request";

/** Статусы попытки, из которых разрешён ручной ретрай. */
export const RETRYABLE_DELIVERY_STATUSES: DeliveryProviderStatus[] = ["CANCELLED", "FAILED", "PROBLEM", "RETURNED"];
const TERMINAL_ORDER_STATUSES = ["DELIVERED", "CANCELLED"];

export type RetryResult =
  | { outcome: "created"; newDeliveryId: string; attemptNumber: number }
  | { outcome: "already_active"; deliveryId: string }
  | { outcome: "not_retryable"; reason: string }
  | { outcome: "not_eligible"; reason: string };

/** Можно ли показывать кнопку «Создать новую доставку Burq» для этой текущей попытки/заказа. */
export function canRetryDelivery(currentDeliveryStatus: string | null | undefined, orderStatus: string): boolean {
  if (!currentDeliveryStatus) return false;
  if (TERMINAL_ORDER_STATUSES.includes(orderStatus)) return false;
  return (RETRYABLE_DELIVERY_STATUSES as string[]).includes(currentDeliveryStatus);
}

export async function createRetryDeliveryAttempt(prisma: PrismaClient, orderId: string): Promise<RetryResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderStatus: true } });
  if (!order) return { outcome: "not_retryable", reason: "order_missing" };
  if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus)) return { outcome: "not_retryable", reason: "order_terminal" };

  const current = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true }, select: { id: true, status: true } });
  if (!current) return { outcome: "not_retryable", reason: "no_current_delivery" };
  if (!(RETRYABLE_DELIVERY_STATUSES as string[]).includes(current.status)) {
    // Текущая попытка ещё активна (не терминальна) — новую не создаём, возвращаем её (идемпотентность).
    return { outcome: "already_active", deliveryId: current.id };
  }

  // CLAIM: снять isCurrentAttempt с ИМЕННО ЭТОЙ терминальной попытки. Только один запрос выиграет.
  const claim = await prisma.delivery.updateMany({
    where: { id: current.id, isCurrentAttempt: true, status: { in: RETRYABLE_DELIVERY_STATUSES } },
    data: { isCurrentAttempt: false },
  });
  if (claim.count === 0) {
    const nc = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true }, select: { id: true } });
    return { outcome: "already_active", deliveryId: nc?.id ?? current.id };
  }

  const restore = async () => {
    await prisma.delivery.update({ where: { id: current.id }, data: { isCurrentAttempt: true } });
  };

  try {
    const port = createPrismaDraftPort(prisma);
    const ctx = await port.loadContext(orderId);
    if (!ctx) {
      await restore();
      return { outcome: "not_retryable", reason: "order_missing" };
    }
    // Ручной ретрай НЕ зависит от per-site авто-флага → siteAutoCreateEnabled форсим true; проверяем
    // флориста + валидный pickup (+ отсутствие активного draft: после claim его нет).
    const decision = decideDraftEligibility({
      siteAutoCreateEnabled: true,
      orderStatus: ctx.order.orderStatus,
      floristId: ctx.floristId,
      pickup: ctx.pickup,
      hasCurrentDraft: ctx.hasCurrentDraft,
    });
    if (decision.action !== "CREATE_DRAFT") {
      await restore();
      return { outcome: "not_eligible", reason: decision.action === "WAIT_FOR_FLORIST" ? decision.reason : "order_terminal" };
    }

    // Bump версии расписания (инвалидирует устаревшие pending-задачи).
    await prisma.deliveryIntent.upsert({
      where: { orderId },
      create: { orderId, intentStatus: "SCHEDULED" },
      update: { scheduleVersion: { increment: 1 }, intentStatus: "SCHEDULED", lastSkipReason: null },
    });

    const attempt = ctx.nextAttemptNumber;
    const referenceId = `${orderId}:a${attempt}`;
    const req = buildBurqDraftRequest(referenceId, ctx.order.dropoff, ctx.pickup!, ctx.dimensions ?? DEFAULT_BURQ_DIMENSIONS);
    const client = await getBurqRuntimeClient();
    const burqRes = await client.createDraft(req, `burq:create:${orderId}:${attempt}`); // throw → restore ниже

    // persistDraft: снимает isCurrentAttempt с прочих (их нет), создаёт новую isCurrentAttempt=true.
    await port.persistDraft({
      orderId,
      floristId: ctx.floristId!,
      attemptNumber: attempt,
      externalDeliveryId: burqRes.id,
      checkoutUrl: burqRes.checkoutUrl,
      rawStatus: burqRes.status,
      referenceId,
    });

    const newDel = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true }, select: { id: true } });
    // Связи supersedes + сброс фактической стоимости (актуальная доставка ещё не выбрана).
    await prisma.$transaction([
      prisma.delivery.update({ where: { id: newDel!.id }, data: { supersedesDeliveryId: current.id } }),
      prisma.delivery.update({ where: { id: current.id }, data: { supersededByDeliveryId: newDel!.id } }),
      prisma.order.update({ where: { id: orderId }, data: { deliveryActualCost: new Prisma.Decimal(0) } }),
    ]);
    return { outcome: "created", newDeliveryId: newDel!.id, attemptNumber: attempt };
  } catch (err) {
    await restore(); // при любой ошибке возвращаем прежнюю текущую попытку
    throw err;
  }
}
