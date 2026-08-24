"use server";
/**
 * Пометка о работе с клиентом по заказу — действие владельца.
 *
 * ТОЛЬКО OWNER: и «не писать этому клиенту», и «попросить отзыв» — решения владельца, а не
 * колл-центра. Оператор пометку видит и выполняет, но не ставит.
 *
 * Вся логика — в modules/orders/marketingMark.ts; здесь только права и обновление страницы.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import type { OrderMarketingMark } from "@/generated/prisma/client";
import { setOrderMarketingMark } from "@/modules/orders/marketingMark";

export async function setOrderMarketingMarkAction(
  orderId: string,
  mark: OrderMarketingMark | null
): Promise<{ ok?: true; error?: string }> {
  const user = await requireRole("OWNER");
  const res = await setOrderMarketingMark(orderId, mark, { userId: user.id, role: user.role });
  if (!res.ok) return { error: res.error };
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  return { ok: true };
}
