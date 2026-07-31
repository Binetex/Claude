/**
 * Деривация внутреннего состояния заказа Floremart из Shopify-payload и правила anti-rollback
 * при обновлении. Чистые функции (без сети/БД) — тестируемы, по образцу
 * `woocommerce/orderState.ts`.
 *
 * Почему обновление и создание разведены. При СОЗДАНИИ статус берётся из payload целиком.
 * При ОБНОВЛЕНИИ применять то же самое нельзя: у заказа к этому моменту есть внутренние рабочие
 * этапы (ASSIGNED/IN_PROGRESS/READY/…), которых Shopify не знает, и «оплачен, но не выполнен»
 * из payload затёр бы их в CONFIRMED. Поэтому на update переносятся только ТЕРМИНАЛЬНЫЕ факты
 * платформы (отменён / выполнен) плюс исторический переход «оплатили ожидающий заказ».
 */
import type { PaymentStatus, OrderStatus, DeliveryStatus } from "@/generated/prisma/enums";

/** Тонкий срез Shopify-payload, от которого зависит статус (не тащим весь заказ в чистый модуль). */
export type ShopifyStateSignal = {
  cancelledAt: string | null | undefined;
  fulfillmentStatus: string | null | undefined;
};

/** Терминальные внутренние статусы: назад из них не откатываемся никогда. */
const TERMINAL = new Set<OrderStatus>(["DELIVERED", "CANCELLED"]);

/**
 * Состояние заказа по payload (путь СОЗДАНИЯ):
 *  - отменён (cancelled_at)            → CANCELLED;
 *  - выполнен (fulfillment=fulfilled)  → DELIVERED (+ доставка DELIVERED);
 *  - иначе оплачен                     → CONFIRMED (требует назначения флориста);
 *  - иначе                             → AWAITING_PAYMENT.
 * Терминальные (CANCELLED/DELIVERED) и не оплаченные назначения флориста НЕ требуют.
 */
export function deriveShopifyOrderState(
  signal: ShopifyStateSignal,
  paymentStatus: PaymentStatus
): { orderStatus: OrderStatus; deliveryStatus?: DeliveryStatus } {
  if (signal.cancelledAt) return { orderStatus: "CANCELLED" };
  if (signal.fulfillmentStatus === "fulfilled") return { orderStatus: "DELIVERED", deliveryStatus: "DELIVERED" };
  return { orderStatus: paymentStatus === "PAID" ? "CONFIRMED" : "AWAITING_PAYMENT" };
}

/**
 * Что записать в СУЩЕСТВУЮЩИЙ заказ по пришедшему обновлению. Возвращает только те поля,
 * которые действительно надо изменить; `undefined` означает «не трогаем» (и так же
 * передаётся в prisma.update).
 *
 * Порядок правил:
 *  1) терминальный внутренний статус не откатываем ничем;
 *  2) отменён на стороне Shopify → CANCELLED;
 *  3) выполнен на стороне Shopify → DELIVERED + доставка DELIVERED (перекрывает рабочие
 *     этапы: «выполнен» — терминальный факт платформы, а не промежуточное мнение о заказе);
 *  4) исторический переход «ожидал оплаты и оплатили» → CONFIRMED;
 *  5) во всех остальных случаях статус не меняем.
 */
export function reconcileShopifyUpdate(
  existing: { orderStatus: string },
  signal: ShopifyStateSignal,
  paymentStatus: PaymentStatus
): { orderStatus?: OrderStatus; deliveryStatus?: DeliveryStatus } {
  if (TERMINAL.has(existing.orderStatus as OrderStatus)) return {};

  if (signal.cancelledAt) return { orderStatus: "CANCELLED" };
  if (signal.fulfillmentStatus === "fulfilled") return { orderStatus: "DELIVERED", deliveryStatus: "DELIVERED" };
  if (paymentStatus === "PAID" && existing.orderStatus === "AWAITING_PAYMENT") return { orderStatus: "CONFIRMED" };

  return {};
}
