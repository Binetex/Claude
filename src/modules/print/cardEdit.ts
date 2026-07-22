import "server-only";
/**
 * Редактирование ТЕКСТА ОТКРЫТКИ (Order.cardMessage). Меняет ТОЛЬКО cardMessage.
 * НЕ трогает originalCardMessage / customerNote, НЕ шлёт ничего во внешний магазин, НЕ запускает
 * sync/webhook/SMS/Burq. Флорист может править только назначенный ему заказ (currentFloristId).
 */
import { prisma } from "@/lib/db";
import { normalizeCardMessage } from "@/lib/print/cardText";

/**
 * Флорист меняет текст открытки своего заказа. Возвращает ok=false, если заказ не найден ИЛИ
 * не принадлежит флористу — БЕЗ различия причин (чужой заказ не раскрываем).
 */
export async function floristSetCardMessage(orderId: string, floristId: string, rawText: string): Promise<{ ok: boolean }> {
  const text = normalizeCardMessage(rawText);
  const res = await prisma.order.updateMany({
    where: { id: orderId, currentFloristId: floristId }, // владение проверяется в самом WHERE
    data: { cardMessage: text }, // ТОЛЬКО cardMessage
  });
  return { ok: res.count === 1 };
}

/** Владелец меняет текст открытки любого заказа (без внешнего пуша). */
export async function ownerSetCardMessage(orderId: string, rawText: string): Promise<{ ok: boolean }> {
  const text = normalizeCardMessage(rawText);
  const res = await prisma.order.updateMany({ where: { id: orderId }, data: { cardMessage: text } });
  return { ok: res.count === 1 };
}
