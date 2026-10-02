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

/**
 * `requestId` — какой отправке формы принадлежит ответ. Модалка показывает только ответ на
 * СВОЮ отправку: иначе «возврат создан» от прошлого раза висел бы в новой форме и держал
 * кнопку выключенной, и второй частичный возврат требовал бы перезагрузки страницы.
 */
export type RefundFormState = { error?: string; ok?: boolean; message?: string; unknown?: boolean; requestId?: string } | null;

/** Состояние для модалки: сколько оплачено, сколько уже вернули, сколько можно вернуть. */
export async function loadRefundState(orderId: string) {
  await requireRole("OWNER");
  return getRefundState(orderId);
}

/**
 * Создать возврат.
 *
 * Подтверждение одно — номер заказа, и проверяется оно НА СЕРВЕРЕ: защита от случайного
 * клика. Пароля учётной записи здесь нет (владелец 03.10.2026: «чтобы не спрашивал какой-то
 * пароль непонятный»). От двойного возврата защищает не форма, а `requestId` и перепроверка
 * доступной суммы по свежим данным Airwallex (`createOrderRefund`).
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
    return { requestId, error: `Для подтверждения введите номер заказа: ${orderNumber}` };
  }

  const amount = Number(amountRaw.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return { requestId, error: "Сумма возврата должна быть больше нуля." };

  const res = await createOrderRefund({ orderId, amount, reason, requestId });

  if (res.ok) {
    revalidatePath(`/dashboard/orders/${orderId}`);
    return { requestId, ok: true, message: `Возврат ${res.refund.amount} ${res.refund.currency} создан (${res.refund.status}).` };
  }
  // Исход неизвестен — повторять нельзя, и форма обязана сказать это иначе, чем «ошибка».
  if (res.kind === "unknown") {
    revalidatePath(`/dashboard/orders/${orderId}`);
    return { requestId, error: res.message, unknown: true };
  }
  return { requestId, error: res.message };
}
