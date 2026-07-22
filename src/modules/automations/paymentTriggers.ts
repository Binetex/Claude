/**
 * Сопоставление состояния оплаты с триггером автоматизации. Чистая функция — тестируется без БД.
 *
 * Границы (согласовано с владельцем):
 *  - PAYMENT_PENDING запускается ТОЛЬКО для настроенного BNPL-метода (Airwallex/Klarna в
 *    ожидании подтверждения). Обычный неоплаченный заказ триггер НЕ запускает: у Woo он тоже
 *    классифицируется как PAYMENT_PENDING, но писать клиенту там не о чем.
 *  - ORDER_REFUNDED — только ПОЛНЫЙ возврат. PARTIALLY_REFUNDED чаще корректировка суммы.
 *  - Триггеры доступны только WooCommerce: Shopify не разбирает BNPL и не заполняет
 *    paymentClassification, там «ожидает оплаты» и «оплата не прошла» неразличимы (оба UNPAID).
 */
export type PaymentTriggerType = "PAYMENT_PENDING" | "PAYMENT_FAILED" | "ORDER_REFUNDED";

export type PaymentSignal = {
  /** Результат classifyWooPayment; null — классификации нет (напр. заказ до внедрения). */
  classification: string | null | undefined;
  /** Это настроенный BNPL-метод. */
  payLater?: boolean;
};

export function paymentTriggerFor(signal: PaymentSignal, paymentStatus: string): PaymentTriggerType | null {
  // Полный возврат определяем по paymentStatus: он платформо-независим и уже согласован
  // с anti-rollback логикой reconcileOrderState.
  if (paymentStatus === "REFUNDED") return "ORDER_REFUNDED";
  if (signal.classification === "REFUNDED") return "ORDER_REFUNDED";
  if (signal.classification === "PAYMENT_FAILED") return "PAYMENT_FAILED";
  // Ожидание подтверждения — только у BNPL.
  if (signal.classification === "PAYMENT_PENDING" && signal.payLater) return "PAYMENT_PENDING";
  return null;
}
