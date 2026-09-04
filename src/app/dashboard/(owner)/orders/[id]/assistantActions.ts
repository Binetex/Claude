"use server";
/**
 * Выключатель ассистента на конкретном заказе — действие владельца.
 *
 * Сильнее режима магазина: пока галочка стоит, по этому заказу ассистент не отвечает и не
 * шлёт «one moment», а уже написанные черновики нажатием кнопки не уходят.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";

export async function setOrderAssistantDisabledAction(orderId: string, disabled: boolean): Promise<{ ok?: true; error?: string }> {
  await requireRole("OWNER");
  const r = await prisma.order.updateMany({ where: { id: orderId }, data: { aiDisabled: disabled } });
  if (r.count !== 1) return { error: "Заказ не найден." };
  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true };
}
