import "server-only";
/**
 * Отзыв у ПОЛУЧАТЕЛЯ букета (владелец 07.10.2026: «чтобы мог это запрашивать иногда»).
 *
 * Обычно отзыв просят у заказчика — пометкой «Попросить отзыв» на заказе. Получателя просят
 * изредка и по решению владельца: кнопкой в карточке заказа или кнопкой под подсказкой ИИ в
 * Telegram, когда получательница благодарит за букет (`assistant/reviewSuggest.ts`). Дальше всё
 * как у заказчика: запрос в той же очереди «Отзывы», задача колл-центру, звонки, ссылка, купон —
 * только с номером получателя.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { createReviewRequest, type RequestActor } from "./requests";

export type AskRecipientResult = { ok: true; id: string; created: boolean } | { ok: false; error: string };

export async function askRecipientReview(db: PrismaClient, orderId: string, actor: RequestActor): Promise<AskRecipientResult> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { senderPhone: true, recipientPhone: true } });
  if (!order) return { ok: false, error: "Заказ не найден." };
  const phone = toE164(order.recipientPhone);
  if (!phone) return { ok: false, error: "У получателя нет номера телефона." };
  // Один номер на двоих — получатель и есть заказчик: у него просят обычной пометкой.
  if (phone === toE164(order.senderPhone)) {
    return { ok: false, error: "Получатель — сам заказчик: попросите отзыв пометкой «Попросить отзыв»." };
  }

  const res = await createReviewRequest(db, orderId, actor, "RECIPIENT");
  // Задача оператору — только на новый запрос и только после записи: открыв ссылку из Telegram,
  // он должен застать запрос уже в очереди.
  if (res.created) {
    await publishTelegramNotification(db, {
      type: "order.ask_review_recipient",
      orderId,
      occurrenceKey: `order:${orderId}:ask_review_recipient`,
    });
  }
  return { ok: true, ...res };
}
