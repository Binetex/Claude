/**
 * Единственное место, где собирается адрес печатного документа открыток.
 * Точек входа две — вкладка «Открытки для печати» и карточка заказа, — и обе должны вести
 * на один и тот же документ (/print/order-cards), а не на свои варианты печати.
 *
 * Права проверяет СЕРВЕР на самой странице (loadPrintableCards: флорист видит только свои
 * заказы), поэтому передавать id в открытом виде безопасно.
 */
export function printCardsUrl(orderIds: string | string[]): string {
  const ids = (Array.isArray(orderIds) ? orderIds : [orderIds]).filter(Boolean);
  return `/print/order-cards?ids=${encodeURIComponent(ids.join(","))}`;
}
