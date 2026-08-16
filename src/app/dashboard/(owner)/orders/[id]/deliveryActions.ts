"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { resolveDeliveryManually, type ManualDecision } from "@/integrations/delivery/burq/manualResolution";
import { createRetryDeliveryAttempt } from "@/integrations/delivery/burq/retryService";
import { refetchPodForDelivery } from "@/integrations/delivery/burq/podService";
import { linkBurqOrder } from "@/integrations/delivery/burq/linkService";
import { makeCompletedPublisher } from "@/integrations/delivery/burq/webhookHandler";
import { onOrderDeliveryChange } from "@/integrations/delivery/burq/scheduleService";
import { fixDeliveryActualCost, FinanceFixError } from "@/modules/finance/fix";

type FormState = { error?: string; ok?: boolean; message?: string } | null;
type LinkFormState = { error?: string; ok?: boolean; message?: string; needsConfirm?: boolean } | null;

const DECISIONS: ManualDecision[] = ["mark_delivered", "mark_cancelled", "record_refund", "leave_problem"];

/**
 * Ручное разрешение проблемной доставки. Доступно ЛЮБОМУ аутентифицированному сотруднику
 * (requireUser, НЕ только OWNER). Ручные решения не рассылают уведомления и защищены от
 * перезаписи поздними webhook (manual-lock в reconcile).
 */
export async function resolveDeliveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const deliveryId = String(formData.get("deliveryId") ?? "");
  const decision = String(formData.get("decision") ?? "") as ManualDecision;
  const orderId = String(formData.get("orderId") ?? "");
  if (!deliveryId || !DECISIONS.includes(decision)) return { error: "Некорректное действие." };

  const res = await resolveDeliveryManually(prisma, { deliveryId, decision, userId: user.id });
  if (res.outcome === "delivery_not_found") return { error: "Доставка не найдена." };

  if (orderId) revalidatePath(`/dashboard/orders/${orderId}`);
  const labels: Record<ManualDecision, string> = {
    mark_delivered: "Отмечено доставленным",
    mark_cancelled: "Отмечено отменённым",
    record_refund: "Возврат зафиксирован",
    leave_problem: "Оставлено в статусе проблемы",
  };
  return { ok: true, message: labels[decision] };
}

/**
 * Создать НОВУЮ попытку доставки Burq (после отмены/провала предыдущей). Доступно ЛЮБОМУ
 * аутентифицированному сотруднику (requireUser, НЕ OWNER-only). Идемпотентно (claim-lock):
 * повтор/гонка вернут существующую активную попытку, второй Burq-заказ не создаётся.
 */
export async function createNewDeliveryAttemptAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  if (!orderId) return { error: "Не указан заказ." };

  const res = await createRetryDeliveryAttempt(prisma, orderId);
  revalidatePath(`/dashboard/orders/${orderId}`);
  switch (res.outcome) {
    case "created":
      return { ok: true, message: `Создана новая доставка Burq (попытка #${res.attemptNumber}). Оформите её в Burq.` };
    case "already_active":
      return { ok: true, message: "Активная доставка уже существует — новая не создавалась." };
    case "not_eligible":
      return { error: res.reason === "no_florist" ? "Не назначен флорист." : res.reason === "pickup_invalid" ? "Точка забора флориста не настроена/невалидна." : "Заказ не готов к новой доставке." };
    case "not_retryable":
    default:
      return { error: "Повторная доставка недоступна для этого заказа." };
  }
}

/**
 * Переключение точки забора У КОНКРЕТНОГО ЗАКАЗА. Доступно любому аутентифицированному
 * сотруднику (requireUser) — как остальные Burq-действия на этой странице.
 *
 * Выбирать можно только точки НАЗНАЧЕННОГО флориста: курьер едет туда, где физически лежит
 * букет. Пустое значение снимает ручной выбор — заказ возвращается к основной точке флориста.
 *
 * После сохранения дёргаем единую точку onOrderDeliveryChange: если Burq-черновик уже создан
 * и ещё не оформлен — он удаляется в Burq, старая попытка уходит в историю (PICKUP_CHANGED),
 * создаётся новая с новой точкой. Если черновика ещё нет — просто перепланирование.
 */
export async function setOrderPickupLocationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const pickupLocationId = String(formData.get("pickupLocationId") ?? "").trim() || null;
  if (!orderId) return { error: "Не указан заказ." };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { currentFloristId: true, pickupLocationOverrideId: true },
  });
  if (!order) return { error: "Заказ не найден." };
  if (!order.currentFloristId) return { error: "Не назначен флорист — выбирать точку не из чего." };

  if (pickupLocationId) {
    const loc = await prisma.floristPickupLocation.findUnique({
      where: { id: pickupLocationId },
      select: { floristId: true, isActive: true },
    });
    if (!loc || loc.floristId !== order.currentFloristId) return { error: "Точка не принадлежит флористу заказа." };
    if (!loc.isActive) return { error: "Точка отключена — выберите другую." };
  }

  if (order.pickupLocationOverrideId === pickupLocationId) {
    return { ok: true, message: "Точка забора не изменилась." };
  }

  await prisma.order.update({ where: { id: orderId }, data: { pickupLocationOverrideId: pickupLocationId } });

  let outcome: Awaited<ReturnType<typeof onOrderDeliveryChange>> = null;
  try {
    outcome = await onOrderDeliveryChange(prisma, orderId, "PICKUP_CHANGED");
  } catch (err) {
    console.error(`[burq] pickup change recreate failed for order ${orderId}:`, err instanceof Error ? err.message : String(err));
    revalidatePath(`/dashboard/orders/${orderId}`);
    return { error: "Точка сохранена, но пересоздать доставку в Burq не удалось. Проверьте панель доставки." };
  }

  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath(`/dashboard/f/${orderId}`);

  if (outcome?.outcome === "flagged_problem") {
    return { error: "Доставка уже оформлена в Burq — точка сохранена, но доставка не пересоздана. Решите вручную." };
  }
  if (outcome?.outcome === "recreated") {
    return { ok: true, message: "Точка забора изменена, доставка Burq пересоздана. Оформите её в Burq заново." };
  }
  if (outcome?.outcome === "waiting") {
    return { ok: true, message: "Точка забора изменена. Прежняя доставка отменена, новая пока не создана — заказ ждёт." };
  }
  return { ok: true, message: "Точка забора изменена. Черновик Burq будет создан с новой точкой." };
}

/**
 * Ручное обновление Proof of Delivery: GET Burq order → перечитать POD-поля → обновить ссылки.
 * Статус заказа/оплату НЕ меняет. Доступно ЛЮБОМУ аутентифицированному сотруднику (requireUser).
 */
export async function refetchPodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const deliveryId = String(formData.get("deliveryId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  if (!deliveryId) return { error: "Не указана доставка." };
  try {
    const res = await refetchPodForDelivery(prisma, deliveryId);
    if (orderId) revalidatePath(`/dashboard/orders/${orderId}`);
    switch (res.outcome) {
      case "updated":
        return { ok: true, message: `Обновлено фото подтверждения: ${res.count}.` };
      case "no_photo":
        return { ok: true, message: "Burq пока не вернул фотографию подтверждения доставки." };
      default:
        return { error: "Не удалось обновить фото (доставка не найдена)." };
    }
  } catch {
    return { error: "Ошибка обращения к Burq. Попробуйте позже." };
  }
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT_PENDING: "черновик создаётся",
  DRAFT_CREATED: "черновик создан",
  COURIER_ASSIGNED: "курьер назначен",
  IN_TRANSIT: "в пути",
  PICKED_UP: "заказ забран",
  DELIVERED: "доставлено",
  PROBLEM: "проблема",
  CANCELLED: "отменена",
  FAILED: "ошибка доставки",
  RETURNED: "возвращено",
};

/**
 * Ручная привязка существующего Burq Order ID (o_...) к заказу. GET (read-only) → создаёт/переиспользует
 * Delivery attempt и сразу подтягивает статус/стоимость/POD/tracking/курьера через существующую логику.
 * Burq order НЕ создаёт, POST/DELETE в Burq не делает. Доступно любому аутентифицированному сотруднику.
 */
export async function linkBurqOrderAction(_prev: LinkFormState, formData: FormData): Promise<LinkFormState> {
  await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const burqOrderId = String(formData.get("burqOrderId") ?? "").trim();
  const confirm = String(formData.get("confirm") ?? "") === "1";
  if (!orderId) return { error: "Не указан заказ." };
  if (!burqOrderId) return { error: "Введите Burq Order ID." };

  let res;
  try {
    res = await linkBurqOrder(prisma, makeCompletedPublisher(prisma), { orderId, burqOrderId, replaceActive: confirm });
  } catch {
    return { error: "Ошибка обращения к Burq. Попробуйте позже." };
  }
  revalidatePath(`/dashboard/orders/${orderId}`);
  switch (res.outcome) {
    case "linked": {
      const label = STATUS_LABEL[res.status] ?? res.status;
      return { ok: true, message: `Привязано (попытка #${res.attemptNumber}). Статус: ${label}.` };
    }
    case "needs_confirmation":
      return { needsConfirm: true, message: "У заказа уже есть активная доставка Burq." };
    case "already_linked_other":
      return { error: "Этот Burq Order уже привязан к другому заказу Floremart." };
    case "burq_not_found":
      return { error: "Burq Order с таким ID не найден." };
    case "invalid_id":
      return { error: "Некорректный Burq Order ID (ожидается вид o_…)." };
    case "order_not_found":
      return { error: "Заказ не найден." };
    default:
      return { error: "Не удалось привязать Burq Order." };
  }
}

/**
 * Подтверждение фактической стоимости доставки руками — для случаев, когда Burq не участвовал:
 * отвезли сами или чужим курьером. Без подтверждения финансовый модуль не считает ВЕСЬ ДЕНЬ:
 * пустое поле там означает «не знаем, сколько стоило», а не «бесплатно».
 *
 * Ноль — обычное и самое частое значение (отвёз сам), поэтому вводится он явно: подтверждённый
 * ноль и незаполненное поле обязаны различаться, иначе прибыль дня окажется завышенной.
 *
 * ТОЛЬКО ВЛАДЕЛЕЦ — это финансовое решение, как и все правки в модуле финансов (проверку делает
 * assertOwner внутри fixDeliveryActualCost).
 */
export async function confirmDeliveryActualCostAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const raw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  if (!orderId) return { error: "Некорректный запрос." };

  const amount = Number(raw);
  if (raw === "" || !Number.isFinite(amount) || amount < 0) {
    return { error: "Введите сумму: 0 или больше." };
  }
  // Копейки округляем, а не отбрасываем: 14.995 должно стать 15.00, а не 14.99.
  const amountCents = Math.round(amount * 100);

  try {
    await fixDeliveryActualCost({ orderId, amountCents, actor: { userId: user.id, role: user.role } });
  } catch (err) {
    const message = err instanceof FinanceFixError ? err.message : "Не удалось сохранить стоимость.";
    return { error: message };
  }

  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true, message: amountCents === 0 ? "Отмечено: доставка бесплатная." : "Стоимость доставки сохранена." };
}
