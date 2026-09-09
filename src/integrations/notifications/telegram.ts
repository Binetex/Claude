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
  opts: { previousFloristId?: string | null; assignmentId?: string | null } = {}
): Promise<void> {
  /**
   * Ключ дедупликации в очереди — по КОНКРЕТНОМУ назначению, а не по паре «заказ + флорист».
   * Иначе возврат заказа прежнему флористу (A → B → A) давал тот же ключ, что и первое
   * назначение, очередь считала событие уже опубликованным и уведомление не уходило вовсе.
   * OrderAssignment создаётся на каждое назначение, поэтому его id — естественная граница
   * «одно уведомление на одно назначение». Без него (старые вызовы) поведение прежнее.
   */
  const per = opts.assignmentId ? `:a${opts.assignmentId}` : "";
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
    occurrenceKey: `${orderId}:${floristId}${per}`,
    context: { floristName: nameOf(floristId) },
  });

  if (opts.previousFloristId && opts.previousFloristId !== floristId) {
    await publishTelegramNotification(prisma, {
      type: "order.handed_over",
      orderId,
      floristId: opts.previousFloristId,
      occurrenceKey: `${orderId}:${opts.previousFloristId}:to:${floristId}${per}`,
      context: { toFloristName: nameOf(floristId) },
    });
  }
}

/**
 * Дату или окно доставки изменили.
 *
 * Два действия, и оба обязательны:
 *  1) НОВОЕ сообщение флористу — прежнюю карточку он уже прочитал и планировал день по ней,
 *     тихая правка старого сообщения до него не дойдёт;
 *  2) обновление уже отправленных карточек (флориста и владельца), иначе они продолжат
 *     показывать старую дату. Именно это и случилось с JF-1001374: заказ перенесли на
 *     сегодня, а в Telegram у флориста осталось «10 Sep».
 *
 * `occurrenceKey` включает новую дату: outbox не считает это повтором прежней публикации,
 * а реестр по своему dedupeKey решает, править существующее сообщение или слать новое.
 */
export async function notifyDeliveryChanged(
  orderId: string,
  change: { fromText: string | null; toText: string | null }
): Promise<void> {
  const order = await prisma.order
    .findUnique({ where: { id: orderId }, select: { currentFloristId: true } })
    .catch(() => null);

  const stamp = `${change.toText ?? "-"}`.replace(/[^0-9A-Za-z]+/g, "");

  if (order?.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "order.delivery_changed",
      orderId,
      floristId: order.currentFloristId,
      occurrenceKey: `${orderId}:${order.currentFloristId}:${stamp}`,
      context: { fromText: change.fromText, toText: change.toText },
    });

    // Освежаем карточку заказа у флориста: она показывает дату и после переноса врёт.
    await publishTelegramNotification(prisma, {
      type: "order.assigned",
      orderId,
      floristId: order.currentFloristId,
      occurrenceKey: `${orderId}:${order.currentFloristId}:refresh:${stamp}`,
      context: {},
    });
  }

  // И карточку у владельца — по той же причине.
  await publishTelegramNotification(prisma, {
    type: "order.created",
    orderId,
    occurrenceKey: `${orderId}:refresh:${stamp}`,
    context: {},
  });
}
