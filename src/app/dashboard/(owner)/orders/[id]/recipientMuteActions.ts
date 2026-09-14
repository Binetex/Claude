"use server";
/**
 * «Сюрприз: получателю не пишем» — выключатель на конкретном заказе.
 *
 * Гасит всё, что система пишет получателю САМА: автоматизации и ручную отправку из карточки на
 * его номер. Ответ на его собственное входящее не гасит (см. Order.recipientMuted).
 *
 * Решение фиксируется в аудите заказа: «почему получателю ничего не ушло» — вопрос, на который
 * через неделю должен отвечать журнал, а не память.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";

export async function setOrderRecipientMutedAction(orderId: string, muted: boolean): Promise<{ ok?: true; error?: string }> {
  const actor = await requireRole("OWNER");
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { recipientMuted: true } });
  if (!order) return { error: "Заказ не найден." };
  // Повторное нажатие того же значения следа не оставляет: аудит отвечает на вопрос «когда
  // решение изменилось», а не «сколько раз нажали».
  if (order.recipientMuted === muted) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { recipientMuted: muted } });
    await tx.orderAudit.create({
      data: {
        orderId,
        userId: actor.id,
        role: actor.role,
        block: "communications",
        changed: { recipientMuted: { from: order.recipientMuted, to: muted } },
      },
    });
  });

  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true };
}
