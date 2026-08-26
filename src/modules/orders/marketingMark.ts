import "server-only";
/**
 * Пометка владельца о работе с клиентом по конкретному заказу.
 *
 *  · MUTED      — не писать клиенту маркетинговые цепочки (Marketing Flows). Клиент пожаловался
 *                 или заказ проблемный, и цепочка отзыва продолжила бы к нему стучаться.
 *  · ASK_REVIEW — наоборот: попросить отзыв. Колл-центр получает задачу в Telegram и видит
 *                 пометку в своей карточке заказа.
 *  · null       — обычный заказ.
 *
 * Значения взаимоисключающие, поэтому это ОДНО поле, а не два флага: нельзя одновременно
 * молчать и просить отзыв.
 *
 * Служебные уведомления («доставка сегодня», «заказ доставлен», трек) не зависят от пометки
 * ни в одном из значений — они про сам заказ, а не про маркетинг, и клиент их ждёт.
 *
 * MUTED гасит и будущие цепочки, и уже запущенные: движок сверяется с пометкой перед КАЖДЫМ
 * шагом (`automations/flows/handler.ts`), поэтому отдельная уборка запланированных шагов не
 * нужна — они останавливаются сами и оставляют в «Истории» причину.
 */
import type { OrderMarketingMark, Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { createReviewRequest } from "@/modules/reviews/requests";

export type MarkResult = { ok: true; mark: OrderMarketingMark | null } | { ok: false; error: string };

export async function setOrderMarketingMark(
  orderId: string,
  mark: OrderMarketingMark | null,
  actor: { userId: string; role: Role }
): Promise<MarkResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { marketingMark: true } });
  if (!order) return { ok: false, error: "Заказ не найден." };

  // Повторное нажатие того же значения следа не оставляет и задачу оператору не дублирует:
  // аудит отвечает на вопрос «когда решение изменилось», а не «сколько раз нажали».
  if (order.marketingMark === mark) return { ok: true, mark };

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { marketingMark: mark } });
    await tx.orderAudit.create({
      data: {
        orderId,
        userId: actor.userId,
        role: actor.role,
        block: "marketing",
        changed: { marketingMark: { from: order.marketingMark, to: mark } },
      },
    });
  });

  if (mark === "ASK_REVIEW") {
    // Карточка запроса создаётся ДО уведомления: оператор откроет ссылку из телеграма и должен
    // застать заказ уже в своей очереди, а не пустую страницу. Повторная пометка второго
    // запроса не заводит — иначе клиенту звонили бы дважды.
    await createReviewRequest(prisma, orderId, actor);

    // Уведомление — ПОСЛЕ фиксации: сообщение о том, чего нет в базе, хуже отсутствия
    // сообщения. Публикация best-effort и заказ не роняет.
    await publishTelegramNotification(prisma, {
      type: "order.ask_review",
      orderId,
      occurrenceKey: `order:${orderId}:ask_review`,
    });
  }

  return { ok: true, mark };
}
