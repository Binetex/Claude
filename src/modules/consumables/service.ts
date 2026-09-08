import "server-only";
/**
 * Дневная сводка расходников: сколько чего ушло по заказам дня.
 *
 * Расход = правило по снимку позиций заказа, если человек не поправил руками. Ручная правка —
 * строка ConsumableUsage; её отсутствие означает «действует правило», а не ноль.
 */
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { consumablesForOrder, VASE_LABEL, type VaseKey } from "./rules";
import { getOrderItemImages } from "@/modules/orders/images";

export type ConsumableItemRow = {
  id: string;
  name: string;
  siteId: string | null;
  autoRule: string | null;
  autoKey: string | null;
  imageUrl: string | null;
  sortOrder: number;
};

export type OrderConsumableRow = {
  orderId: string;
  orderNumber: string;
  siteName: string;
  floristName: string | null;
  productSummary: string;
  /** Фото букета — то же, что в очереди отзывов: строку узнают по картинке, а не по номеру. */
  photoUrl: string | null;
  /** Что насчитало правило: itemId → количество. */
  auto: Map<string, number>;
  /** Что поправил человек: itemId → количество (перебивает правило). */
  manual: Map<string, number>;
  /** Ваза есть, а тип не распознан — это нужно видеть, а не прятать. */
  unknownVases: number;
};

export type DaySummary = {
  day: Date;
  orders: OrderConsumableRow[];
  /** itemId → итог за день с учётом ручных правок. */
  totals: Map<string, number>;
  unknownVases: number;
};

/** Заказы, которые вообще участвуют в учёте: отменённые и неоплаченные расходников не тратят. */
export function consumableOrderWhere(floristId?: string | null): Prisma.OrderWhereInput {
  return {
    orderStatus: { notIn: ["CANCELLED", "AWAITING_PAYMENT"] },
    ...(floristId ? { currentFloristId: floristId } : {}),
  };
}

export async function loadConsumableItems(prisma: PrismaClient, includeArchived = false): Promise<ConsumableItemRow[]> {
  const rows = await prisma.consumableItem.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, siteId: true, autoRule: true, autoKey: true, imageUrl: true, sortOrder: true },
  });
  return rows;
}

/**
 * Расход по заказам за период.
 *
 * Тип вазы берётся сперва из текста позиции, затем из связанной вазы каталога — поэтому здесь
 * подтягиваются варианты: без них букеты вида «Bellgrass & Vase» остались бы без типа.
 */
export async function loadOrdersWithConsumables(
  prisma: PrismaClient,
  input: { from: Date; to: Date; floristId?: string | null; items: ConsumableItemRow[] }
): Promise<OrderConsumableRow[]> {
  const orders = await prisma.order.findMany({
    where: { deliveryDate: { gte: input.from, lt: input.to }, ...consumableOrderWhere(input.floristId) },
    orderBy: [{ deliveryDate: "asc" }, { orderNumber: "asc" }],
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      siteId: true,
      site: { select: { name: true, shortName: true } },
      currentFlorist: { select: { user: { select: { name: true } } } },
      items: {
        select: {
          name: true, variantName: true, quantity: true, productId: true, variantId: true,
          image: true, parentImageUrl: true, variantImageUrl: true,
        },
      },
      consumableUsages: { select: { itemId: true, quantity: true } },
    },
  });

  const vaseNameByKey = await loadLinkedVaseNames(
    prisma,
    orders.map((o) => ({ items: o.items.map((i) => ({ productId: i.productId, variantId: i.variantId })) }))
  );

  return orders.map((o) => {
    const branded = input.items.some((i) => i.siteId === o.siteId && i.autoRule === "BRANDED_ENVELOPE");
    const calc = consumablesForOrder({
      storeHasBranding: branded,
      items: o.items.map((i) => ({
        name: i.name,
        variantName: i.variantName,
        quantity: i.quantity,
        linkedVaseName: vaseNameByKey.get(`${i.variantId ?? ""}|${i.productId ?? ""}`) ?? null,
      })),
    });

    const auto = new Map<string, number>();
    for (const item of input.items) {
      if (item.siteId && item.siteId !== o.siteId) continue;
      const n = autoQuantityFor(item, calc);
      if (n > 0) auto.set(item.id, n);
    }

    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      siteName: o.site?.shortName || o.site?.name || "—",
      floristName: o.currentFlorist?.user.name ?? null,
      productSummary: o.items.map((i) => i.name).join(", "),
      photoUrl: o.items.map((i) => getOrderItemImages(i).primary).find((u) => !!u) ?? null,
      auto,
      manual: new Map(o.consumableUsages.map((u) => [u.itemId, u.quantity])),
      unknownVases: calc.vasesByType.get("UNKNOWN") ?? 0,
    };
  });
}

function autoQuantityFor(item: ConsumableItemRow, calc: ReturnType<typeof consumablesForOrder>): number {
  switch (item.autoRule) {
    case "CARE_GUIDE_VASE":
      return calc.careGuide === "VASE" ? 1 : 0;
    case "CARE_GUIDE_BOUQUET":
      return calc.careGuide === "BOUQUET" ? 1 : 0;
    case "BRANDED_ENVELOPE":
      return calc.brandedEnvelope;
    case "VASE_BOTTOM":
      return calc.vaseBottoms;
    case "VASE_TYPE":
      return item.autoKey ? calc.vasesByType.get(item.autoKey as VaseKey) ?? 0 : 0;
    default:
      return 0; // только руками
  }
}

/** Названия ваз, связанных с вариантом или товаром: нужны, когда тип не написан в названии. */
async function loadLinkedVaseNames(
  prisma: PrismaClient,
  orders: { items: { productId: string | null; variantId: string | null }[] }[]
): Promise<Map<string, string>> {
  const variantIds = new Set<string>();
  const productIds = new Set<string>();
  for (const o of orders) {
    for (const i of o.items) {
      if (i.variantId) variantIds.add(i.variantId);
      if (i.productId) productIds.add(i.productId);
    }
  }
  if (!variantIds.size && !productIds.size) return new Map();

  const [variants, products] = await Promise.all([
    variantIds.size
      ? prisma.productVariant.findMany({
          where: { id: { in: [...variantIds] } },
          select: { id: true, includedVaseVariant: { select: { title: true, product: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
    productIds.size
      ? prisma.product.findMany({
          where: { id: { in: [...productIds] } },
          select: { id: true, defaultIncludedVaseVariant: { select: { title: true, product: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  // Название вазы = «товар + вариант»: у варианта в title лежит размер («8 in»), а сам тип —
  // в названии товара («White Matte Glass Vase»).
  const nameOfVariant = (v: { title: string | null; product: { name: string } } | null) =>
    v ? [v.product.name, v.title].filter(Boolean).join(" ") : null;

  const byVariant = new Map(variants.map((v) => [v.id, nameOfVariant(v.includedVaseVariant)]));
  const byProduct = new Map(products.map((p) => [p.id, nameOfVariant(p.defaultIncludedVaseVariant)]));

  const out = new Map<string, string>();
  for (const o of orders) {
    for (const i of o.items) {
      const name = (i.variantId ? byVariant.get(i.variantId) : null) ?? (i.productId ? byProduct.get(i.productId) : null);
      if (name) out.set(`${i.variantId ?? ""}|${i.productId ?? ""}`, name);
    }
  }
  return out;
}

/** Итог по дню: ручная правка перебивает расчёт. */
export function totalsFor(orders: OrderConsumableRow[], items: ConsumableItemRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    let sum = 0;
    for (const o of orders) sum += o.manual.get(item.id) ?? o.auto.get(item.id) ?? 0;
    if (sum) totals.set(item.id, sum);
  }
  return totals;
}

export function groupByDay(orders: OrderConsumableRow[], byOrderDay: Map<string, Date>, items: ConsumableItemRow[]): DaySummary[] {
  const byDay = new Map<string, OrderConsumableRow[]>();
  for (const o of orders) {
    const d = byOrderDay.get(o.orderId);
    if (!d) continue;
    const key = d.toISOString().slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(o);
    byDay.set(key, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, list]) => ({
      day: new Date(`${key}T00:00:00.000Z`),
      orders: list,
      totals: totalsFor(list, items),
      unknownVases: list.reduce((n, o) => n + o.unknownVases, 0),
    }));
}

export { VASE_LABEL };
