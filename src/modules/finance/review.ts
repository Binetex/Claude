import "server-only";
/**
 * Очередь разбора: доставленные заказы, за которые никто ничего не получил.
 *
 * Состояния НЕ хранятся отдельной таблицей — они выводятся запросом из заказов и ledger.
 * Второй источник правды («статус разбора») неизбежно разъехался бы с книгой, а признак
 * «разобрано» уже есть и он честный: по заказу появилась хоть одна запись в ledger.
 *
 * Всё гейтится датой старта начислений. Без неё в очередь попали бы 89 доставленных
 * заказов исторического backfill'а Shopify, у которых флориста не было и не будет —
 * владелец получил бы экран мусора вместо рабочего списка.
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { accrualGate } from "./config";
import { listCurrentProfiles } from "./profile";

export type ReviewOrder = {
  id: string;
  orderNumber: string;
  siteShortName: string;
  deliveryDate: Date;
  customerTotal: number;
  floristTotal: number;
  floristName: string | null;
  reason: "NO_FLORIST" | "FLORIST_PRICE_MISSING" | "NO_FINANCE_PROFILE";
};

export type ReviewQueue = {
  /** Гейт закрыт — списки пустые, и владельцу надо объяснить почему, а не показывать ноль. */
  disabledReason: string | null;
  noFlorist: ReviewOrder[];
  needsPrice: ReviewOrder[];
};

const REVIEW_LIMIT = 200;

export async function getReviewQueue(): Promise<ReviewQueue> {
  const gate = accrualGate();
  if (!gate.enabled) return { disabledReason: gate.reason, noFlorist: [], needsPrice: [] };

  // Заказы, по которым в книге уже что-то есть (начисление, ручная корректировка,
  // подтверждённый ноль) — из очереди уходят.
  const settledRows = await prisma.ledgerEntry.findMany({
    where: { orderId: { not: null }, order: { deliveryDate: { gte: gate.startDate } } },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  const settled = new Set(settledRows.map((r) => r.orderId!));

  const orders = await prisma.order.findMany({
    where: {
      orderStatus: "DELIVERED",
      deliveryDate: { gte: gate.startDate },
      ...(settled.size ? { id: { notIn: [...settled] } } : {}),
    },
    orderBy: { deliveryDate: "desc" },
    take: REVIEW_LIMIT,
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      customerTotal: true,
      floristTotal: true,
      priceMode: true,
      currentFloristId: true,
      isBackfilled: true,
      site: { select: { shortName: true } },
      currentFlorist: { select: { user: { select: { name: true } } } },
      items: { select: { name: true, productId: true, variantId: true, floristItemPrice: true } },
    },
  });

  const profiles = await listCurrentProfiles();
  const noFlorist: ReviewOrder[] = [];
  const needsPrice: ReviewOrder[] = [];

  for (const o of orders) {
    const base = {
      id: o.id,
      orderNumber: o.orderNumber,
      siteShortName: o.site.shortName,
      deliveryDate: o.deliveryDate,
      customerTotal: toNumber(o.customerTotal),
      floristTotal: toNumber(o.floristTotal),
      floristName: o.currentFlorist?.user.name ?? null,
    };

    if (!o.currentFloristId) {
      // Исторический хвост Shopify: заказы перенесены как факт задним числом, флориста у
      // них не было и не будет. В очереди это 29 строк, по которым нечего решать, —
      // они бы только прятали единственный настоящий случай. Заказ с назначенным
      // флористом сюда не попадает, поэтому фильтр стоит именно здесь, а не в запросе.
      if (o.isBackfilled) continue;
      noFlorist.push({ ...base, reason: "NO_FLORIST" });
      continue;
    }

    const profile = profiles.get(o.currentFloristId);
    if (!profile) {
      needsPrice.push({ ...base, reason: "NO_FINANCE_PROFILE" });
      continue;
    }
    // Основной флорист получает долю за период на следующем этапе — это не «нет цены».
    if (profile.model === "PRIMARY") continue;

    // Ноль означает «цена не задана»: заработок по такому заказу не считается, и он
    // уходит в разбор. Отдельных правил начисления больше нет — долг выводится напрямую.
    if (toNumber(o.floristTotal) <= 0) needsPrice.push({ ...base, reason: "FLORIST_PRICE_MISSING" });
  }

  return { disabledReason: null, noFlorist, needsPrice };
}

/** Счётчики для бейджей в списке флористов и в навигации. */
export async function getReviewCounts(): Promise<{ noFlorist: number; needsPrice: number }> {
  const queue = await getReviewQueue();
  return { noFlorist: queue.noFlorist.length, needsPrice: queue.needsPrice.length };
}

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
