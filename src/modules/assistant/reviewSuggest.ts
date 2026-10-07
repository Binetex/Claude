import "server-only";
/**
 * Подсказка владельцу: получатель благодарит за букет — попросить у него отзыв?
 * (владелец 07.10.2026: «нейронка бы сама предлагала запросить отзыв, если получательница
 * благодарит нас за доставку»).
 *
 * Благодарность узнаётся двумя путями: короткое «Thank you!» — правилом (`policy.ts::isThanks`),
 * его модель не видит, это вежливая точка; всё длиннее — моделью (`intent: "thanks"`). Сама
 * подсказка ничего клиенту не шлёт и запроса не создаёт: решает владелец кнопкой «Попросить отзыв»
 * под сообщением (`telegramReply.ts` → `reviews/recipient.ts`).
 *
 * Только когда: заказ доставлен, пишет именно получатель (номер совпал с номером получателя, и он
 * не тот же, что у заказчика), запроса отзыва у получателя ещё нет. Одна подсказка на заказ —
 * повторную очередь не пропустит по ключу.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { pickOrderTarget } from "./deliver";

export async function suggestRecipientReview(
  prisma: PrismaClient,
  order: { id: string; orderStatus: string; senderPhone: string | null; recipientPhone: string | null } | null,
  site: { aiDryRun: boolean },
  incoming: { externalPhoneNormalized: string; partyRole: string },
  quote: string
): Promise<boolean> {
  if (!order || order.orderStatus !== "DELIVERED") return false;
  if (pickOrderTarget(incoming.externalPhoneNormalized, incoming.partyRole, order) !== "RECIPIENT") return false;
  if (toE164(order.recipientPhone) === toE164(order.senderPhone)) return false;
  const asked = await prisma.orderReviewRequest.findUnique({
    where: { orderId_party: { orderId: order.id, party: "RECIPIENT" } },
    select: { id: true },
  });
  if (asked) return false;

  await publishTelegramNotification(prisma, {
    type: "assistant.review_suggest",
    orderId: order.id,
    occurrenceKey: `order:${order.id}:review_suggest`,
    context: { quote: quote.slice(0, 200), note: site.aiDryRun ? "🧪 Сухой прогон" : null },
  });
  return true;
}

export function logReviewSuggestError(err: unknown) {
  console.error("[assistant] подсказка «попросить отзыв у получателя» не ушла:", err instanceof Error ? err.message : String(err));
}
