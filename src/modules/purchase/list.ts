import "server-only";
import { prisma } from "@/lib/db";
import { localDateStr, todayStrInTz } from "@/lib/tz";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { getOrderItemImages } from "@/modules/orders/images";

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
      items: { select: { name: true, variantName: true, quantity: true, floristCompositionSnapshot: true, image: true, parentImageUrl: true, variantImageUrl: true } },
    },
    orderBy: { deliveryDate: "asc" },
  });

  const result: PurchaseItem[] = [];
  for (const o of orders) {
    // «Сегодня» — по календарной дате в таймзоне магазина. deliveryDate хранится как день (UTC-полночь).
    const today = todayStrInTz(o.site.timezone);
    const deliveryDay = localDateStr(o.deliveryDate, "UTC");
    if (deliveryDay !== today) continue;
    for (const it of o.items) {
      result.push({
        orderNumber: o.orderNumber,
        productName: it.name,
        variantName: it.variantName,
        quantity: it.quantity,
        composition: it.floristCompositionSnapshot,
        // Закупка — агрегированный список: только родительское фото, без фото вариации.
        image: getOrderItemImages(it).primary,
      });
    }
  }
  return result;
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
