/**
 * Определение lifecycle-переходов заказа для триггеров автоматизаций. Чистая функция —
 * тестируется без БД и используется ОБОИМИ ingest'ами (Shopify и WooCommerce), чтобы
 * «заказ оплачен / доставлен / отменён» означало на обеих платформах одно и то же.
 *
 * Триггер публикуется ТОЛЬКО на реальном переходе состояния (prev → next), а не на каждом
 * приёме заказа: повторный webhook/resync с тем же состоянием перехода не даёт и триггера не
 * рождает. Второй слой защиты — occurrenceKey в outbox (`orderId:TRIGGER`), поэтому даже при
 * ошибочном повторном вызове событие в очереди будет одно.
 *
 * Границы (осознанные, покрыты тестами):
 *  - ORDER_PAID считается по paid-like состоянию (PAID и PAY_LATER_APPROVED) — ровно так же,
 *    как условие `requirePaid` в conditions.ts. BNPL-approved заказ движок уже везде считает
 *    оплаченным/рабочим, и расхождение здесь было бы источником сюрпризов.
 *  - ORDER_PAID возможен и в момент СОЗДАНИЯ заказа: заказ приходит к нам уже оплаченным
 *    (обычный happy path Shopify), и появление такой записи — это и есть момент, когда мы
 *    узнали об оплате.
 *  - ORDER_DELIVERED и ORDER_CANCELLED, наоборот, публикуются ТОЛЬКО для уже существующего
 *    заказа. Заказ, впервые появившийся у нас сразу доставленным/отменённым, — это импорт
 *    истории, а не наблюдённый нами переход, и рассылать по нему нечего.
 *  - Возврат у WooCommerce даёт orderStatus=CANCELLED + paymentStatus=REFUNDED. Это ORDER_REFUNDED
 *    (публикуется отдельно через paymentTriggers), поэтому ORDER_CANCELLED в этом случае НЕ
 *    выдаём — иначе на одно событие клиент получил бы два сообщения.
 */

export type OrderLifecycleSnapshot = { orderStatus: string; paymentStatus: string };

export type LifecycleTriggerType = "ORDER_PAID" | "ORDER_DELIVERED" | "ORDER_CANCELLED";

/** Состояния, которые движок повсеместно трактует как «оплачено» (см. conditions.ts). */
const PAID_LIKE = new Set(["PAID", "PAY_LATER_APPROVED"]);

/**
 * Какие lifecycle-триггеры породил переход prev → next.
 * `prev = null` означает создание заказа (см. границы в шапке файла).
 */
export function orderLifecycleTriggers(
  prev: OrderLifecycleSnapshot | null,
  next: OrderLifecycleSnapshot
): LifecycleTriggerType[] {
  const triggers: LifecycleTriggerType[] = [];

  const wasPaid = prev ? PAID_LIKE.has(prev.paymentStatus) : false;
  if (!wasPaid && PAID_LIKE.has(next.paymentStatus)) triggers.push("ORDER_PAID");

  // Дальше — только наблюдённые переходы уже существующего заказа.
  if (!prev) return triggers;

  if (prev.orderStatus !== "DELIVERED" && next.orderStatus === "DELIVERED") {
    triggers.push("ORDER_DELIVERED");
  }

  if (prev.orderStatus !== "CANCELLED" && next.orderStatus === "CANCELLED") {
    // Отмена-по-возврату — это ORDER_REFUNDED, отдельный триггер. Не дублируем.
    const becameRefunded = next.paymentStatus === "REFUNDED" && prev.paymentStatus !== "REFUNDED";
    if (!becameRefunded) triggers.push("ORDER_CANCELLED");
  }

  return triggers;
}
