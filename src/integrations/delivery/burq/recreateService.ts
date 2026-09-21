import "server-only";
/**
 * Ручное ПЕРЕСОЗДАНИЕ доставки Burq сотрудником.
 *
 * Зачем отдельно от «создать новую попытку» (`retryService`): та работает только когда прошлая
 * попытка уже числится завершённой. А в жизни чаще наоборот — доставка числится живой, но по
 * факту мертва: Burq отменил её у себя, курьер уехал и не забрал букет, заказ завис в
 * назначении. Флористу в этот момент нужна одна кнопка, а не разбор, в каком состоянии система
 * считает доставку.
 *
 * Главное ограничение — не наше: **Burq даёт удалить только НЕИНИЦИИРОВАННЫЙ черновик**. Как
 * только доставка оформлена и курьер ищется или назначен, DELETE по их API запрещён. Поэтому
 * исходов два, и они честно разные:
 *
 *  - черновик не инициирован → удаляем в Burq и создаём новую, делать больше нечего;
 *  - доставка живая → у нас закрывается и создаётся новая, но СТАРУЮ В BURQ ОБЯЗАН ОТМЕНИТЬ
 *    ЧЕЛОВЕК в их кабинете. Не отменит — приедут два курьера и магазин заплатит дважды.
 *    Поэтому такой случай требует ОТДЕЛЬНОГО подтверждения (`force`), а не проходит молча.
 *
 * Саму новую попытку создаёт `createRetryDeliveryAttempt`, а не этот файл. Там уже есть всё,
 * чего требует ручное действие: claim-lock от двойного нажатия, принудительная проверка
 * пригодности в обход per-site флага автосоздания (ручное действие не должен глушить
 * выключенный автомат) и возврат прежней попытки на место, если новую создать не удалось.
 * Второй копии этой логики быть не должно — разойдясь, одна из них оставит заказ вообще без
 * активной доставки, и починить это из интерфейса будет нечем.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";
import { BurqApiError } from "./client";
import { getBurqRuntimeClient } from "./settings";
import { mapBurqStatus } from "./statusMap";
import { decideReassignment } from "./reassignment";
import { handleFloristReassignment } from "./reassignmentService";
import { createRetryDeliveryAttempt } from "./retryService";

const TERMINAL_ORDER_STATUSES = ["DELIVERED", "CANCELLED"];

export type RecreateResult =
  /** Старая закрыта (и удалена в Burq, если это было возможно), новая создана. */
  | { outcome: "recreated" }
  /** Новая создана, но старую живую доставку человек обязан отменить в кабинете Burq сам. */
  | { outcome: "recreated_cancel_in_burq" }
  /** Доставка живая: спрашиваем подтверждение, прежде чем плодить вторую. */
  | { outcome: "needs_confirmation"; liveStatus: string }
  /** Новую создать не удалось (нет флориста, не настроена точка забора). */
  | { outcome: "waiting"; reason: string }
  | { outcome: "not_possible"; reason: string };

/**
 * Живой статус доставки в Burq. Локальный мог устареть — именно поэтому кнопка и нужна:
 * Burq отменил доставку у себя, а у нас она числится активной.
 */
async function liveStatus(externalDeliveryId: string): Promise<DeliveryProviderStatus> {
  const client = await getBurqRuntimeClient();
  try {
    const remote = await client.getOrder(externalDeliveryId);
    return mapBurqStatus(remote.status);
  } catch (err) {
    // Заказа в Burq нет вовсе — считаем отменённым: пересоздавать можно без оглядки.
    if (err instanceof BurqApiError && err.status === 404) return "CANCELLED";
    throw err;
  }
}

/**
 * Закрыть текущую попытку и отдать создание новой проверенному пути ретрая.
 *
 * Флаг `isCurrentAttempt` НЕ снимаем — его снимет сам ретрай своим claim-lock. Сняв его здесь,
 * мы бы отобрали у него и защиту от двойного нажатия, и возврат попытки на место при неудаче.
 */
async function closeThenRetry(
  prisma: PrismaClient,
  orderId: string,
  deliveryId: string,
  reason: string
): Promise<RecreateResult> {
  const closed = await prisma.delivery.updateMany({
    where: { id: deliveryId, isCurrentAttempt: true },
    data: { status: "CANCELLED", cancellationReason: reason, cancelledAt: new Date() },
  });
  // Кто-то успел раньше: не закрываем ничего повторно, но новую всё равно попробуем создать —
  // ретрай идемпотентен и вернёт уже существующую активную попытку.
  if (closed.count === 0) return { outcome: "waiting", reason: "already_changed" };

  const res = await createRetryDeliveryAttempt(prisma, orderId);
  switch (res.outcome) {
    case "created":
    case "already_active":
      return { outcome: "recreated" };
    case "not_eligible":
      return { outcome: "waiting", reason: res.reason };
    default:
      return { outcome: "waiting", reason: "retry_failed" };
  }
}

export async function recreateDelivery(
  prisma: PrismaClient,
  orderId: string,
  opts: { force?: boolean } = {}
): Promise<RecreateResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderStatus: true } });
  if (!order) return { outcome: "not_possible", reason: "order_missing" };
  if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus)) return { outcome: "not_possible", reason: "order_terminal" };

  const current = await prisma.delivery.findFirst({
    where: { orderId, isCurrentAttempt: true },
    select: { id: true, status: true, externalDeliveryId: true },
  });
  if (!current) return { outcome: "not_possible", reason: "no_current_delivery" };

  // Черновик ещё не доехал до Burq — удалять там нечего.
  if (!current.externalDeliveryId) return closeThenRetry(prisma, orderId, current.id, "MANUAL_RECREATE");

  const live = await liveStatus(current.externalDeliveryId);
  const decision = decideReassignment(live);

  // Неинициированный черновик: удалить в Burq и пересоздать умеет существующий путь целиком.
  if (decision.action === "DELETE_AND_RECREATE") {
    const res = await handleFloristReassignment(prisma, orderId, "INPUTS_CHANGED");
    if (res.outcome === "recreated") return { outcome: "recreated" };
    if (res.outcome === "waiting") return { outcome: "waiting", reason: res.reason };
    return { outcome: "not_possible", reason: res.outcome === "flagged_problem" ? res.reason : res.outcome };
  }

  // Доставка уже завершилась (Burq отменил, провал, возврат) — в Burq отменять нечего.
  if (decision.reason === "terminal") return closeThenRetry(prisma, orderId, current.id, "MANUAL_RECREATE");

  // Доставка ЖИВАЯ. Вторая появится рядом с первой, и это стоит денег — спрашиваем.
  if (!opts.force) return { outcome: "needs_confirmation", liveStatus: live };
  const res = await closeThenRetry(prisma, orderId, current.id, "MANUAL_RECREATE_LIVE");
  return res.outcome === "recreated" ? { outcome: "recreated_cancel_in_burq" } : res;
}
