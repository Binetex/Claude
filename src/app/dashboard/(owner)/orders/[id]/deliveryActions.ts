"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { resolveDeliveryManually, type ManualDecision } from "@/integrations/delivery/burq/manualResolution";
import { createRetryDeliveryAttempt } from "@/integrations/delivery/burq/retryService";

type FormState = { error?: string; ok?: boolean; message?: string } | null;

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
