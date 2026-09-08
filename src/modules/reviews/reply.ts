import "server-only";
/**
 * «Клиент ответил» — мостик от приёма QUO к воронке отзывов.
 *
 * Входящее от ЗАКАЗЧИКА возвращает его запрос отзыва человеку: до этого ответ уходил в общий
 * поток входящих, и людей теряли — человек писал «да, оставлю», а к нему больше не возвращались.
 *
 * Ищем ПО НОМЕРУ заказчика, а не по заказу входящего. Приём привязывает сообщение к заказу с
 * ближайшей датой доставки, поэтому ответ постоянного клиента на просьбу по СТАРОМУ заказу
 * запросто окажется привязан к новому — или ни к какому (`ambiguous`). По заказу такой ответ не
 * находился вовсе, и запрос уходил в «игнорирует», хотя на той же карточке горело «клиент
 * ответил» (её считает `queueView` — по номеру). Один признак — один источник.
 *
 * По номеру же отсекается и ответ ПОЛУЧАТЕЛЯ букета: отзыв просят у заказчика, и «спасибо,
 * красивые» от получателя не значит, что заказчик отреагировал.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { recordCustomerReply, REPLY_REOPENS_FROM } from "./requests";

/** Насколько старые запросы ещё считаем живыми. Дальше это архив, а не ожидание ответа. */
const LOOKBACK_DAYS = 90;

/** Возвращает true, если запрос действительно вернулся в работу. Сбой не роняет приём входящего. */
export async function noteReviewReply(db: PrismaClient, communicationId: string): Promise<boolean> {
  try {
    const c = await db.orderCommunication.findUnique({
      where: { id: communicationId },
      select: { direction: true, externalPhoneNormalized: true, occurredAt: true },
    });
    if (!c || c.direction !== "INBOUND") return false;
    const phone = toE164(c.externalPhoneNormalized);
    if (!phone) return false;

    // Ждущих ответа запросов единицы, поэтому сравниваем телефоны в коде: в заказе номер хранится
    // как ввёл магазин («(310) 555-0100»), и сравнивать его строкой в SQL нельзя.
    const waiting = await db.orderReviewRequest.findMany({
      where: {
        status: { in: REPLY_REOPENS_FROM },
        linkSentAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000) },
      },
      select: { id: true, order: { select: { senderPhone: true } } },
      orderBy: { linkSentAt: "desc" },
      take: 200,
    });

    const hit = waiting.find((r) => toE164(r.order.senderPhone) === phone);
    if (!hit) return false;

    return await recordCustomerReply(db, hit.id, c.occurredAt);
  } catch (err) {
    console.error("[reviews] не удалось отметить ответ клиента:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
