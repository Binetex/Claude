import "server-only";
import { prisma } from "@/lib/db";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/**
 * Уведомления флористам о назначении заказа. Сигнатура сохранена ради вызывающего кода
 * (assignments/service.ts), внутри — durable outbox.
 *
 * При передаче заказа отправляются ДВА уведомления, потому что бот не может редактировать
 * чужое сообщение: прежний флорист получает пометку в СВОЁМ сообщении (его же ботом), новый —
 * полноценное новое от своего бота. Иначе у прежнего флориста навсегда осталось бы сообщение,
 * будто заказ всё ещё за ним.
 */
export async function notifyFloristAssigned(
  floristId: string,
  orderId: string,
  opts: { previousFloristId?: string | null } = {}
): Promise<void> {
  const names = await prisma.florist
    .findMany({
      where: { id: { in: [floristId, ...(opts.previousFloristId ? [opts.previousFloristId] : [])] } },
      select: { id: true, user: { select: { name: true } } },
    })
    .catch(() => []);
  const nameOf = (id: string | null | undefined) => (id ? names.find((n) => n.id === id)?.user.name ?? null : null);

  await publishTelegramNotification(prisma, {
    type: "order.assigned",
    orderId,
    floristId,
    occurrenceKey: `${orderId}:${floristId}`,
    context: { floristName: nameOf(floristId) },
  });

  if (opts.previousFloristId && opts.previousFloristId !== floristId) {
    await publishTelegramNotification(prisma, {
      type: "order.handed_over",
      orderId,
      floristId: opts.previousFloristId,
      occurrenceKey: `${orderId}:${opts.previousFloristId}:to:${floristId}`,
      context: { toFloristName: nameOf(floristId) },
    });
  }
}
