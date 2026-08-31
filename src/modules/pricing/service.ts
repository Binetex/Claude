import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/money";
import { computeEstimatedProfit } from "./profit";
import { compensableItems, effectiveFloristTotal, isTipItem } from "./serviceItems";

type ItemForPricing = {
  id: string;
  name: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  externalPrice: Prisma.Decimal; // цена клиента за единицу — fallback «полная стоимость»
};

// Поля, по которым позиция резолвится в цену. name нужен, чтобы отсечь служебные строки
// (чаевые) до того, как сработает фолбэк «цена не задана → полная стоимость клиента».
const PRICING_SELECT = { id: true, name: true, productId: true, variantId: true, quantity: true, externalPrice: true } as const;

const ZERO = new Prisma.Decimal(0);

/**
 * Резолвит цену изготовления за ЕДИНИЦУ по каждой позиции для конкретного флориста.
 * Приоритет (см. требования владельца):
 *   1) индивидуальный override флориста для варианта (FloristProductPrice + variantId);
 *   2) ProductVariant.floristPrice (не NULL);
 *   3) индивидуальный override флориста для товара (FloristProductPrice, variantId = null);
 *   4) Product.floristPrice (не NULL);
 *   5) если нигде не задано (везде NULL) — НОЛЬ, признак «цена не задана».
 *
 * NULL означает «цена флориста не задана». Явный 0 — валидная цена (флорист бесплатно).
 * Различить эти два случая по результату нельзя, и это осознанно: оба означают «платить
 * пока не за что», и оба должны попасть владельцу на глаза, а не молча стать суммой.
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
    // Нигде не задано → НОЛЬ, то есть «цена не задана».
    //
    // Раньше здесь подставлялась цена КЛИЕНТА, и это дорого стоило: система молча обещала
    // флористу полную сумму заказа, а узнавал об этом владелец от самого флориста. Ноль —
    // тот же язык, на котором говорит финансовый модуль: он трактует нулевой итог как
    // «цена не задана» и отправляет заказ в «Требует заполнения», где это видно сразу.
    //
    // Занизить заработок ноль не может: он не выплата, а признак незаполненных данных.
    // Цена клиента же выглядела как настоящее число, и отличить её от честной цены было
    // нельзя ни на экране, ни в расчёте.
    unitById.set(item.id, unit ?? ZERO);
  }
  return unitById;
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
  const allItems = await tx.orderItem.findMany({ where: { orderId }, select: PRICING_SELECT });
  const items = compensableItems(allItems);
  const unitById = await resolveUnitPrices(tx, items, floristId);

  let total = new Prisma.Decimal(0);
  for (const item of allItems) {
    // Служебной позиции фиксируем ноль: переназначение заодно чинит старый снимок в БД.
    const line = isTipItem(item) ? ZERO : (unitById.get(item.id) ?? ZERO).mul(item.quantity);
    total = total.add(line);
    await tx.orderItem.update({ where: { id: item.id }, data: { floristItemPrice: line } });
  }
  return total;
}

/**
 * Обнуляет цену флориста у служебных позиций (чаевые). Нужен там, где сумма задаётся
 * владельцем вручную и снимок позиций не пересчитывается: без этого поправка «на лету»
 * вычла бы чаевые из уже очищенной от них суммы.
 */
export async function clearServiceItemFloristPrices(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId, floristItemPrice: { gt: 0 } },
    select: { id: true, name: true, productId: true, variantId: true },
  });
  const serviceIds = items.filter(isTipItem).map((i) => i.id);
  if (serviceIds.length === 0) return;
  await tx.orderItem.updateMany({ where: { id: { in: serviceIds } }, data: { floristItemPrice: ZERO } });
}

/** Пересчитывает примерную прибыль владельца и записывает её. */
export async function recomputeEstimatedProfit(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: { select: { name: true, productId: true, variantId: true, floristItemPrice: true } } },
  });
  if (!order) return;
  // Формула — одна на весь проект (см. computeEstimatedProfit): доход клиента минус наши
  // расходы. Раньше здесь не учитывалась «Доставка (заказчик)» и налог.
  const profit = computeEstimatedProfit({
    itemsTotal: toNumber(order.itemsTotal),
    tax: toNumber(order.tax),
    tip: toNumber(order.tip),
    deliveryCustomerCost: toNumber(order.deliveryCustomerCost),
    // Чаевые, попавшие в снимок цены флориста у старых заказов, расходом не считаются.
    floristTotal: effectiveFloristTotal(
      toNumber(order.floristTotal),
      order.items.map((i) => ({ ...i, floristItemPrice: toNumber(i.floristItemPrice) }))
    ),
    deliveryActualCost: toNumber(order.deliveryActualCost),
  });
  await tx.order.update({
    where: { id: orderId },
    data: { estimatedProfit: new Prisma.Decimal(profit.toFixed(2)) },
  });
}
