"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { resolveDeliveryManually, type ManualDecision } from "@/integrations/delivery/burq/manualResolution";
import { createRetryDeliveryAttempt } from "@/integrations/delivery/burq/retryService";
import { refetchPodForDelivery } from "@/integrations/delivery/burq/podService";
import { linkBurqOrder } from "@/integrations/delivery/burq/linkService";
import { makeCompletedPublisher } from "@/integrations/delivery/burq/webhookHandler";

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
