"use server";
/**
 * Возврат денег клиенту через Airwallex — действия владельца.
 *
 * ТОЛЬКО OWNER. Возврат необратим, и это не та операция, которую стоит открывать
 * колл-центру или флористу: у них нет ни доступа к платежам, ни полномочий.
 *
 * Вся проверка сумм и статусов живёт в integrations/airwallex/refund.ts — здесь только
 * права, разбор формы и подтверждение. Второго места, где создаётся возврат, быть не должно.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { createOrderRefund, getRefundState } from "@/integrations/airwallex/refund";

export type RefundFormState = { error?: string; ok?: boolean; message?: string; unknown?: boolean } | null;

/** Состояние для модалки: сколько оплачено, сколько уже вернули, сколько можно вернуть. */
export async function loadRefundState(orderId: string) {
  await requireRole("OWNER");
  return getRefundState(orderId);
}

/**
 * Создать возврат.
 *
 * Подтверждение обязательно и проверяется НА СЕРВЕРЕ, а не только в модалке: владелец должен
 * ввести номер заказа. Проверка на клиенте защищает от случайного клика, серверная — от
 * запроса, отправленного мимо интерфейса.
 */
export async function createRefundAction(_prev: RefundFormState, formData: FormData): Promise<RefundFormState> {
  await requireRole("OWNER");

  const orderId = String(formData.get("orderId") ?? "");
  const orderNumber = String(formData.get("orderNumber") ?? "").trim();
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || "Requested by customer";
  const requestId = String(formData.get("requestId") ?? "").trim();

  if (!orderId || !requestId) return { error: "Неполные данные формы." };
  if (confirmation.toLowerCase() !== orderNumber.toLowerCase()) {
    return { error: `Для подтверждения введите номер заказа: ${orderNumber}` };
  }

  const amount = Number(amountRaw.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Сумма возврата должна быть больше нуля." };

  const res = await createOrderRefund({ orderId, amount, reason, requestId });

  if (res.ok) {
    revalidatePath(`/dashboard/orders/${orderId}`);
    return { ok: true, message: `Возврат ${res.refund.amount} ${res.refund.currency} создан (${res.refund.status}).` };
  }
  // Исход неизвестен — повторять нельзя, и форма обязана сказать это иначе, чем «ошибка».
  if (res.kind === "unknown") {
    revalidatePath(`/dashboard/orders/${orderId}`);
    return { error: res.message, unknown: true };
  }
  return { error: res.message };
}
