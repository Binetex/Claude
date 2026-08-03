import "server-only";
import { prisma } from "@/lib/db";
import { localDateStr, todayStrInTz } from "@/lib/tz";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { getOrderItemImages } from "@/modules/orders/images";
import { isTipItem } from "@/modules/pricing/serviceItems";

export type PurchaseItem = {
  orderNumber: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  composition: string | null; // snapshot состава (не live)
  image: string | null; // основное (родительское) фото: parentImageUrl ?? legacy image
};

/**
 * Список закупки на сегодня. Источник — OrderItem.floristCompositionSnapshot (не live-состав).
 * Учитываются только заказы, которые ещё нужно изготовить:
 *  - доставка сегодня по ТАЙМЗОНЕ МАГАЗИНА (не UTC);
 *  - статус не терминальный (DELIVERED/CANCELLED) и не «ожидает оплаты» (AWAITING_PAYMENT);
 *  - оплата не REFUNDED (PARTIALLY_REFUNDED остаётся — частичный возврат не отменяет заказ).
 * Для флориста — только назначенные ему заказы; для владельца — все.
 * Пустой snapshot не скрываем (composition = null), чтобы было видно, что состав нужно заполнить.
 *
 * Позиции НЕ-букеты (ваза, подарок, открытка, прочее — всё, кроме FLOWER_PRODUCT) состава не
 * имеют: закупать по ним нечего. Вместо состава показываем название самого товара. Позиции без
 * классификации (financialType не задан) ведут себя как раньше — букет по умолчанию.
 *
 * Служебные позиции-чаевые (isTipItem) в список не попадают вовсе: это не товар, а строка
 * платежа, и флористу она ничего не говорит.
 */
export async function getTodayPurchaseList(opts: { floristId?: string } = {}): Promise<PurchaseItem[]> {
  const orders = await prisma.order.findMany({
    where: {
      orderStatus: { notIn: [...TERMINAL_ORDER_STATUSES, "AWAITING_PAYMENT"] },
      paymentStatus: { not: "REFUNDED" },
      ...(opts.floristId ? { currentFloristId: opts.floristId } : {}),
    },
    select: {
      orderNumber: true,
      deliveryDate: true,
      site: { select: { timezone: true } },
      items: { select: { name: true, variantName: true, quantity: true, floristCompositionSnapshot: true, image: true, parentImageUrl: true, variantImageUrl: true, productId: true, variantId: true } },
    },
    orderBy: { deliveryDate: "asc" },
  });

  const isFlower = await buildFlowerLookup(orders.flatMap((o) => o.items));

  const result: PurchaseItem[] = [];
  for (const o of orders) {
    // «Сегодня» — по календарной дате в таймзоне магазина. deliveryDate хранится как день (UTC-полночь).
    const today = todayStrInTz(o.site.timezone);
    const deliveryDay = localDateStr(o.deliveryDate, "UTC");
    if (deliveryDay !== today) continue;
    for (const it of o.items) {
      // Чаевые Shopify присылает отдельной строкой line_items — флористу в закупке она не нужна.
      if (isTipItem(it)) continue;
      result.push({
        orderNumber: o.orderNumber,
        productName: it.name,
        variantName: it.variantName,
        quantity: it.quantity,
        // Не-букет закупать не нужно — вместо состава показываем название товара.
        composition: isFlower(it) ? it.floristCompositionSnapshot : it.name,
        // Закупка — агрегированный список: только родительское фото, без фото вариации.
        image: getOrderItemImages(it).primary,
      });
    }
  }
  return result;
}

/**
 * Букет ли позиция. Классификация живёт на варианте (ProductVariant.financialType), а при NULL
 * наследуется от товара (Product.financialType) — тот же порядок, что и в финансовом модуле.
 * Ничего не задано → считаем букетом: так список вёл себя до появления классификации.
 */
async function buildFlowerLookup(items: { productId: string | null; variantId: string | null }[]) {
  const productIds = [...new Set(items.map((i) => i.productId).filter((v): v is string => !!v))];
  const variantIds = [...new Set(items.map((i) => i.variantId).filter((v): v is string => !!v))];

  const [products, variants] = await Promise.all([
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, financialType: true } }) : [],
    variantIds.length ? prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, financialType: true } }) : [],
  ]);
  const byProduct = new Map(products.map((p) => [p.id, p.financialType]));
  const byVariant = new Map(variants.map((v) => [v.id, v.financialType]));

  return (item: { productId: string | null; variantId: string | null }): boolean => {
    const type = (item.variantId ? byVariant.get(item.variantId) : null) ?? (item.productId ? byProduct.get(item.productId) : null) ?? null;
    return type === null || type === "FLOWER_PRODUCT";
  };
}

/** Текст для «Копировать список» / печати. Одинаковые строки НЕ объединяются. */
export function purchaseListToText(items: PurchaseItem[]): string {
  const lines = ["TODAY PURCHASE LIST", ""];
  for (const it of items) {
    const variant = it.variantName ? ` — ${it.variantName}` : "";
    lines.push(`${it.orderNumber}`);
    lines.push(`${it.productName}${variant} × ${it.quantity}`);
    lines.push(it.composition && it.composition.trim() ? it.composition : "Состав варианта не указан");
    lines.push("");
  }
  return lines.join("\n").trim();
}
