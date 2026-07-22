/**
 * Реестр переменных SMS-шаблона + сборка их значений из заказа/сайта. Значения — уже строки,
 * готовые к подстановке (даты/деньги отформатированы). Пустые/отсутствующие данные дают "" —
 * рендер сам решает, что показать/пропустить (см. template.ts), «undefined» в текст не попадает.
 */

export type SmsVariableDef = { key: string; label: string; example: string };

// Порядок = порядок показа в UI (кнопки вставки).
export const SMS_VARIABLES: readonly SmsVariableDef[] = [
  { key: "order_number", label: "Номер заказа", example: "#1234" },
  { key: "sender_name", label: "Имя заказчика", example: "Anna" },
  { key: "recipient_name", label: "Имя получателя", example: "Maria" },
  { key: "sender_phone", label: "Телефон заказчика", example: "+1..." },
  { key: "recipient_phone", label: "Телефон получателя", example: "+1..." },
  { key: "delivery_address", label: "Адрес доставки", example: "1 Main St, Apt 4, Portland" },
  { key: "delivery_date", label: "Дата доставки", example: "2026-07-25" },
  { key: "delivery_time", label: "Окно доставки", example: "14:00 – 18:00" },
  { key: "tracking_url", label: "Ссылка трекинга", example: "https://track..." },
  { key: "store_name", label: "Название магазина", example: "Floremart" },
  { key: "store_phone", label: "Телефон магазина", example: "+1..." },
  { key: "order_total", label: "Сумма заказа", example: "$115.00" },
  { key: "card_message", label: "Текст открытки", example: "Happy Birthday!" },
  { key: "delivery_instructions", label: "Инструкции доставки", example: "Leave at door" },
  { key: "review_url", label: "Ссылка на отзыв", example: "https://review..." },
] as const;

/** Тонкий срез данных, из которого собираются переменные (не тащим весь Prisma-объект в чистый модуль). */
export type OrderVariableSource = {
  orderNumber: string;
  senderName: string | null;
  recipientName: string | null;
  senderPhone: string | null;
  recipientPhone: string | null;
  addressLine: string | null;
  apartment: string | null;
  city: string | null;
  deliveryDate: Date | null;
  deliveryWindow: string | null;
  trackingUrl: string | null;
  cardMessage: string | null;
  deliveryInstructions: string | null;
  customerTotal: number | null;
  storeName: string | null;
  storePhone: string | null;
  reviewUrl: string | null;
  timezone: string | null;
};

function s(v: string | null | undefined): string {
  return v == null ? "" : String(v);
}

function formatDate(d: Date | null, timezone: string | null): string {
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone || "UTC",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(d);
  }
}

function formatMoney(total: number | null): string {
  if (total == null || Number.isNaN(total)) return "";
  return `$${total.toFixed(2)}`;
}

function joinAddress(line: string | null, apartment: string | null, city: string | null): string {
  return [s(line), s(apartment), s(city)].filter((p) => p.trim().length > 0).join(", ");
}

/** Строит карту {переменная → строковое значение} для рендера. Отсутствующее → "". */
export function buildOrderVariables(src: OrderVariableSource): Record<string, string> {
  return {
    order_number: s(src.orderNumber),
    sender_name: s(src.senderName),
    recipient_name: s(src.recipientName),
    sender_phone: s(src.senderPhone),
    recipient_phone: s(src.recipientPhone),
    delivery_address: joinAddress(src.addressLine, src.apartment, src.city),
    delivery_date: formatDate(src.deliveryDate, src.timezone),
    delivery_time: s(src.deliveryWindow),
    tracking_url: s(src.trackingUrl),
    store_name: s(src.storeName),
    store_phone: s(src.storePhone),
    order_total: formatMoney(src.customerTotal),
    card_message: s(src.cardMessage),
    delivery_instructions: s(src.deliveryInstructions),
    review_url: s(src.reviewUrl),
  };
}
