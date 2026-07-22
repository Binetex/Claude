import "server-only";
import { prisma } from "@/lib/db";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/**
 * Уведомление флористам о назначении заказа. Сигнатура сохранена ради вызывающего кода
 * (assignments/service.ts), но внутри теперь durable outbox вместо прежней in-memory заглушки
 * lib/jobs.enqueue, которая только писала в лог.
 *
 * `reassigned` различает первичное назначение и передачу заказа: оба правят ОДНО и то же
 * основное сообщение по заказу (один dedupeKey), меняется лишь заголовок.
 *
 * Проверку featureFlags.telegram здесь НЕ делаем: событие должно попасть в outbox в любом
 * случае, а решение «отправлять или пропустить» принимает обработчик — иначе при выключенном
 * флаге события молча терялись бы, и после включения ничего бы не пришло.
 */
export async function notifyFloristAssigned(floristId: string, orderId: string, opts: { reassigned?: boolean } = {}): Promise<void> {
  const florist = await prisma.florist.findUnique({ where: { id: floristId }, select: { user: { select: { name: true } } } }).catch(() => null);
  await publishTelegramNotification(prisma, {
    type: opts.reassigned ? "order.reassigned" : "order.assigned",
    orderId,
    // Один заказ + один флорист = один факт назначения; повторный вызов дубля не создаёт.
    occurrenceKey: `${orderId}:${floristId}`,
    context: { floristName: florist?.user.name ?? null },
  });
}
