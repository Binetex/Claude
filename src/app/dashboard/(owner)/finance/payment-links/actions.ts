"use server";
/**
 * Создание ссылки на оплату. ТОЛЬКО ВЛАДЕЛЕЦ: ссылка выставляет счёт от имени магазина, и это
 * решение того же порядка, что остальные финансовые.
 *
 * Денег ссылка не двигает — платит по ней клиент сам, — поэтому пароля здесь нет, в отличие от
 * возврата, где деньги уходят со счёта магазина одним нажатием.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createPaymentLink, deactivatePaymentLink, type CreateLinkResult } from "@/modules/payments/paymentLinks";

export async function createPaymentLinkAction(_prev: CreateLinkResult | null, formData: FormData): Promise<CreateLinkResult> {
  await requireRole("OWNER");
  const res = await createPaymentLink(prisma, {
    title: String(formData.get("title") ?? ""),
    amount: String(formData.get("amount") ?? ""),
  });
  // Список ссылок читается у Airwallex, поэтому обновляем страницу только когда добавилась новая.
  if (res.ok) revalidatePath("/dashboard/finance/payment-links");
  return res;
}

/** Погасить ссылку — когда ошиблись в сумме или названии. Отправленный счёт иначе не отозвать. */
export async function deactivatePaymentLinkAction(id: string): Promise<{ ok?: true; error?: string }> {
  await requireRole("OWNER");
  const res = await deactivatePaymentLink(prisma, id);
  if (res.ok) revalidatePath("/dashboard/finance/payment-links");
  return res;
}
