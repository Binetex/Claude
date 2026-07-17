import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

type ItemForPricing = {
  id: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  externalPrice: Prisma.Decimal; // цена клиента за единицу — fallback «полная стоимость»
};

const ZERO = new Prisma.Decimal(0);

/**
 * Резолвит цену изготовления за ЕДИНИЦУ по каждой позиции для конкретного флориста.
 * Приоритет (см. требования владельца):
 *   1) индивидуальный override флориста для варианта (FloristProductPrice + variantId);
 *   2) ProductVariant.floristPrice (не NULL);
 *   3) индивидуальный override флориста для товара (FloristProductPrice, variantId = null);
 *   4) Product.floristPrice (не NULL);
 *   5) если нигде не задано (везде NULL) — ПОЛНАЯ стоимость заказа (цена клиента).
 *
 * NULL означает «цена флориста не задана». Явный 0 — валидная цена (флорист бесплатно).
 */
async function resolveUnitPrices(
  client: Prisma.TransactionClient,
  items: ItemForPricing[],
  floristId: string
): Promise<Map<string, Prisma.Decimal>> {
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
  const variantIds = [...new Set(items.map((i) => i.variantId).filter((x): x is string => !!x))];

  const [products, variants, overrides] = await Promise.all([
    productIds.length
      ? client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, floristPrice: true } })
      : Promise.resolve([]),
    variantIds.length
      ? client.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, floristPrice: true } })
      : Promise.resolve([]),
    productIds.length || variantIds.length
      ? client.floristProductPrice.findMany({
          where: {
            floristId,
            OR: [
              variantIds.length ? { variantId: { in: variantIds } } : undefined,
              productIds.length ? { productId: { in: productIds }, variantId: null } : undefined,
            ].filter(Boolean) as Prisma.FloristProductPriceWhereInput[],
          },
          select: { productId: true, variantId: true, makeCost: true },
        })
      : Promise.resolve([]),
  ]);

  const productBase = new Map(products.map((p) => [p.id, p.floristPrice]));
  const variantBase = new Map(variants.map((v) => [v.id, v.floristPrice]));
  const overrideByVariant = new Map<string, Prisma.Decimal>();
  const overrideByProduct = new Map<string, Prisma.Decimal>();
  for (const o of overrides) {
    if (o.variantId) overrideByVariant.set(o.variantId, o.makeCost);
    else overrideByProduct.set(o.productId, o.makeCost);
  }

  const unitById = new Map<string, Prisma.Decimal>();
  for (const item of items) {
    let unit: Prisma.Decimal | null = null;
    if (item.variantId && overrideByVariant.has(item.variantId)) {
      unit = overrideByVariant.get(item.variantId)!;
    } else if (item.variantId && variantBase.get(item.variantId) != null) {
      unit = variantBase.get(item.variantId)!;
    } else if (item.productId && overrideByProduct.has(item.productId)) {
      unit = overrideByProduct.get(item.productId)!;
    } else if (item.productId && productBase.get(item.productId) != null) {
      unit = productBase.get(item.productId)!;
    }
    // Нигде не задано → полная стоимость (цена клиента за единицу).
    unitById.set(item.id, unit ?? item.externalPrice);
  }
  return unitById;
}

/**
 * Считает авто-цену флориста по позициям заказа. Возвращает суммарную стоимость
 * и цену по каждой позиции (для предпросмотра до фиксации снимка).
 */
export async function computeAutoFloristPrice(
  orderId: string,
  floristId: string
): Promise<{ total: Prisma.Decimal; perItem: Map<string, Prisma.Decimal> }> {
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    select: { id: true, productId: true, variantId: true, quantity: true, externalPrice: true },
  });
  const unitById = await resolveUnitPrices(prisma, items, floristId);

  let total = new Prisma.Decimal(0);
  const perItem = new Map<string, Prisma.Decimal>();
  for (const item of items) {
    const line = (unitById.get(item.id) ?? ZERO).mul(item.quantity);
    perItem.set(item.id, line);
    total = total.add(line);
  }
  return { total, perItem };
}

/**
 * Записывает снимок авто-цены флориста в заказ и его позиции.
 * Снимок фиксируется в момент назначения — изменение прайса позже не трогает старые заказы.
 */
export async function applyAutoPriceSnapshot(
  tx: Prisma.TransactionClient,
  orderId: string,
  floristId: string
): Promise<Prisma.Decimal> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, productId: true, variantId: true, quantity: true, externalPrice: true },
  });
  const unitById = await resolveUnitPrices(tx, items, floristId);

  let total = new Prisma.Decimal(0);
  for (const item of items) {
    const line = (unitById.get(item.id) ?? ZERO).mul(item.quantity);
    total = total.add(line);
    await tx.orderItem.update({ where: { id: item.id }, data: { floristItemPrice: line } });
  }
  return total;
}

/** Пересчитывает примерную прибыль владельца и записывает её. */
export async function recomputeEstimatedProfit(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  // Прибыль ≈ сумма товаров (без налога/чаевых) − цена флориста − фактическая доставка.
  const profit = order.itemsTotal
    .sub(order.floristTotal)
    .sub(order.deliveryActualCost);
  await tx.order.update({
    where: { id: orderId },
    data: { estimatedProfit: profit },
  });
}
