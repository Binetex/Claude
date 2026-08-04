import "server-only";
/**
 * Сколько заказов флорист довёз — колонка «Доставлено» в списке флористов.
 *
 * Здесь же раньше жила «Очередь разбора»: доставленные заказы без флориста, без цены и без
 * модели оплаты. Экран удалён — он был только для чтения, а все три причины видны прямо в
 * карточке заказа, где их и исправляют. Возвращать очередь отдельной страницей не нужно.
 *
 * Всё гейтится датой старта начислений: без неё в счёт попали бы 89 доставленных заказов
 * исторического backfill'а Shopify, у которых флориста не было и не будет.
 */
import { prisma } from "@/lib/db";
import { accrualGate } from "./config";

/** Число доставленных заказов флориста за период — колонка «доставлено» в списке. */
export async function countDeliveredByFlorist(
  floristIds: string[],
  period?: { from?: Date; to?: Date }
): Promise<Map<string, number>> {
  const result = new Map<string, number>(floristIds.map((id) => [id, 0]));
  if (floristIds.length === 0) return result;
  const gate = accrualGate();

  // Дата старта и фильтр периода — оба нижние границы, поэтому берём ПОЗДНЮЮ из них.
  // Спред двух `gte` в одном объекте молча оставил бы последнюю и мог показать заказы
  // до включения модуля, за которые никто ничего не получал.
  const lowerBounds = [gate.enabled ? gate.startDate : null, period?.from ?? null].filter(
    (d): d is Date => d != null
  );
  const from = lowerBounds.length ? new Date(Math.max(...lowerBounds.map((d) => d.getTime()))) : null;

  const rows = await prisma.order.groupBy({
    by: ["currentFloristId"],
    where: {
      currentFloristId: { in: floristIds },
      orderStatus: "DELIVERED",
      ...(from || period?.to
        ? { deliveryDate: { ...(from ? { gte: from } : {}), ...(period?.to ? { lte: period.to } : {}) } }
        : {}),
    },
    _count: { _all: true },
  });
  for (const r of rows) {
    if (r.currentFloristId) result.set(r.currentFloristId, r._count._all);
  }
  return result;
}
