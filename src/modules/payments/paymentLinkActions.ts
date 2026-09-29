"use server";
/**
 * Ссылки на оплату — действия двух страниц: владельца («Финансы → Ссылки на оплату») и
 * колл-центра. Колл-центру доступ дан решением владельца 29.09.2026 («ссылку для оплаты Севинч
 * сделать»): оператор сам выставляет счёт клиенту, который, например, решил доплатить за другой
 * букет, — не дожидаясь владельца.
 *
 * Денег ссылка не двигает — платит по ней клиент сам, — поэтому пароля здесь нет, в отличие от
 * возврата, где деньги уходят со счёта магазина одним нажатием. Гасить ссылку может тот же круг:
 * ошибся в сумме — отозвал сам.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createPaymentLink, deactivatePaymentLink, type CreateLinkResult } from "./paymentLinks";

/** Список ссылок читается у Airwallex: обновляем обе страницы, только когда что-то поменялось. */
function refreshPages() {
  revalidatePath("/dashboard/finance/payment-links");
  revalidatePath("/dashboard/cc/payment-links");
}

export async function createPaymentLinkAction(_prev: CreateLinkResult | null, formData: FormData): Promise<CreateLinkResult> {
  await requireRole("OWNER", "CALL_CENTER");
  const res = await createPaymentLink(prisma, {
    title: String(formData.get("title") ?? ""),
    amount: String(formData.get("amount") ?? ""),
  });
  if (res.ok) refreshPages();
  return res;
}

/** Погасить ссылку — когда ошиблись в сумме или названии. Отправленный счёт иначе не отозвать. */
export async function deactivatePaymentLinkAction(id: string): Promise<{ ok?: true; error?: string }> {
  await requireRole("OWNER", "CALL_CENTER");
  const res = await deactivatePaymentLink(prisma, id);
  if (res.ok) refreshPages();
  return res;
}
