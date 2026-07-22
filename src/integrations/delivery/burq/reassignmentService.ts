import "server-only";
/**
 * Переназначение флориста, когда Burq draft уже создан. Правила (см. reassignment.ts):
 *  - draft НЕинициирован (`request`) → DELETE в Burq, старую Delivery → CANCELLED
 *    (FLORIST_REASSIGNED, isCurrentAttempt=false), создать новую attempt с pickup нового
 *    флориста (supersedes-связь), bump scheduleVersion;
 *  - draft уже инициирован/активен → PROBLEM (Delivery+Order), ручное решение оператором.
 *
 * Гонки: если статус в Burq успел уйти из `request` между решением и DELETE, ловим ошибку
 * DELETE (409) и уходим в PROBLEM.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { BurqApiError } from "./client";
import { getBurqRuntimeClient } from "./settings";
import { mapBurqStatus } from "./statusMap";
import { decideReassignment } from "./reassignment";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { handleBurqDraftCreate } from "./draftHandler";

export type ReassignmentResult =
  | { outcome: "recreated"; newDeliveryId: string }
  | { outcome: "flagged_problem"; reason: string }
  | { outcome: "waiting"; reason: string }
  | { outcome: "no_current_draft" };

/**
 * Помечает ДОСТАВКУ проблемной (красная плашка + ручное решение). Order.orderStatus НЕ трогаем:
 * проблема относится к доставке, а не к производственному статусу заказа (см. правило mapper'а).
 */
async function flagProblem(prisma: PrismaClient, deliveryId: string, _orderId: string, reason: string): Promise<void> {
  await prisma.$transaction([
    prisma.delivery.update({ where: { id: deliveryId }, data: { status: "PROBLEM", failureCode: reason } }),
    prisma.deliveryStatusEvent.create({
      data: { deliveryId, normalizedStatus: "PROBLEM", source: "SYSTEM", newStatus: "PROBLEM", safeReason: `reassign_${reason}` },
    }),
  ]);
}

export async function handleFloristReassignment(
  prisma: PrismaClient,
  orderId: string,
  cancellationReason: "FLORIST_REASSIGNED" | "INPUTS_CHANGED" = "FLORIST_REASSIGNED"
): Promise<ReassignmentResult> {
  const current = await prisma.delivery.findFirst({
    where: { orderId, isCurrentAttempt: true, externalDeliveryId: { not: null } },
    select: { id: true, externalDeliveryId: true, status: true },
  });
  if (!current || !current.externalDeliveryId) return { outcome: "no_current_draft" };

  const client = await getBurqRuntimeClient();

  // Сверяем ФАКТИЧЕСКИЙ статус в Burq (локальный мог устареть).
  let liveStatus = current.status;
  try {
    const remote = await client.getOrder(current.externalDeliveryId);
    liveStatus = mapBurqStatus(remote.status);
  } catch (err) {
    if (err instanceof BurqApiError && err.status === 404) {
      liveStatus = "CANCELLED"; // draft уже отсутствует в Burq — считаем удалённым
    } else {
      throw err;
    }
  }

  const decision = decideReassignment(liveStatus);
  if (decision.action === "FLAG_PROBLEM") {
    await flagProblem(prisma, current.id, orderId, decision.reason);
    return { outcome: "flagged_problem", reason: decision.reason };
  }

  // DELETE_AND_RECREATE — удаляем неинициированный draft в Burq.
  try {
    await client.deleteOrder(current.externalDeliveryId);
  } catch (err) {
    if (!(err instanceof BurqApiError && err.status === 404)) {
      // 409 (уже инициирован) или иная ошибка → безопасно уходим в PROBLEM.
      await flagProblem(prisma, current.id, orderId, "delete_failed");
      return { outcome: "flagged_problem", reason: "delete_failed" };
    }
  }

  // Старую Delivery — в историю как CANCELLED (FLORIST_REASSIGNED), снимаем текущий флаг.
  await prisma.delivery.update({
    where: { id: current.id },
    data: { status: "CANCELLED", isCurrentAttempt: false, cancellationReason, cancelledAt: new Date() },
  });

  // Bump версии расписания (инвалидирует устаревшие pending-задачи) и создаём новую attempt.
  await prisma.deliveryIntent.update({ where: { orderId }, data: { scheduleVersion: { increment: 1 }, intentStatus: "SCHEDULED", lastSkipReason: null } });

  const port = createPrismaDraftPort(prisma);
  const ctx = await port.loadContext(orderId);
  const res = await handleBurqDraftCreate({ client, port }, { orderId, scheduleVersion: ctx?.order.scheduleVersion ?? 0 });
  if (res.outcome !== "created") {
    // Старый draft уже удалён/отменён. Новый не создан — это НЕ проблема доставки, а корректное
    // ожидание нового флориста/pickup (WAITING) или осознанный пропуск (SKIP). Intent уже записан.
    if (res.outcome === "waiting") return { outcome: "waiting", reason: res.reason };
    return { outcome: "waiting", reason: `recreate_${res.outcome}` };
  }

  // Связываем supersedes: новая ← старая.
  const created = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true }, select: { id: true } });
  if (created) {
    await prisma.$transaction([
      prisma.delivery.update({ where: { id: created.id }, data: { supersedesDeliveryId: current.id } }),
      prisma.delivery.update({ where: { id: current.id }, data: { supersededByDeliveryId: created.id } }),
    ]);
    return { outcome: "recreated", newDeliveryId: created.id };
  }
  return { outcome: "recreated", newDeliveryId: res.externalDeliveryId };
}
