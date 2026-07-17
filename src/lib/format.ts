import { format } from "date-fns";

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(new Date(d), "dd.MM.yyyy");
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(new Date(d), "dd.MM.yyyy HH:mm");
}

/** Короткий адрес для карточек */
export function shortAddress(addressLine: string, city: string): string {
  return `${addressLine}, ${city}`;
}

/**
 * Отображаемый номер заказа: только "#1058", без префикса сайта. `Order.orderNumber`
 * для Shopify-заказов хранится как "{shortName}-{order_number}" (нужно для уникальности
 * между разными сайтами — см. ingestOrder.ts), но в интерфейсе это лишний шум.
 * Локальные/сид-заказы уже хранятся в виде "#NNNN" — возвращаем как есть.
 */
export function formatOrderNumber(orderNumber: string): string {
  if (orderNumber.startsWith("#")) return orderNumber;
  const idx = orderNumber.lastIndexOf("-");
  return idx === -1 ? orderNumber : `#${orderNumber.slice(idx + 1)}`;
}
