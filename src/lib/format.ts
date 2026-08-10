import { format } from "date-fns";

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(new Date(d), "dd.MM.yyyy");
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(new Date(d), "dd.MM.yyyy HH:mm");
}

/**
 * Окно доставки человеку: «12:00 – 16:00» → «12PM – 4PM», «14:30-18:00» → «2:30PM – 6PM».
 * Ровные часы без минут: «11:00» → «11AM», а не «11:00AM».
 *
 * ВАЖНО: `Order.deliveryWindow` — свободная строка. Магазины присылают что угодно
 * («12:00 – 16:00», «14:00–18:00», «10-14», «10:00 AM - 2:00 PM»), и владелец правит её
 * руками. Поэтому функция ПЕРЕПИСЫВАЕТ только то, что целиком опознала как время или
 * интервал времени; всё остальное возвращается ровно как есть, без попытки угадать.
 * Это только вывод — в БД строка остаётся той же, и в форме редактирования показывается
 * оригинал (иначе правка перезаписала бы данные магазина нашим форматом).
 *
 * Время без am/pm читается как 24-часовое: «16» → 4PM, «9» → 9AM.
 */
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?|(\d{1,2})(?::(\d{2}))?`;
const ONE_TIME = new RegExp(`^\\s*(?:${TIME})\\s*$`, "i");
const RANGE = new RegExp(`^\\s*(?:${TIME})\\s*(?:[-–—]|to|до)\\s*(?:${TIME})\\s*$`, "i");

/** Одно время из групп совпадения. null — часы/минуты вне допустимого. */
function timePart(g: (string | undefined)[]): string | null {
  const [h12, m12, ap, h24, m24] = g;
  const hasAp = ap !== undefined;
  const hour = Number(hasAp ? h12 : h24);
  const min = Number((hasAp ? m12 : m24) ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(min) || min > 59) return null;
  if (hasAp ? hour < 1 || hour > 12 : hour > 23) return null;
  const h = hasAp ? (hour % 12) + (ap.toLowerCase() === "p" ? 12 : 0) : hour;
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12}${min ? `:${String(min).padStart(2, "0")}` : ""}${suffix}`;
}

export function fmtTimeWindow(raw: string | null | undefined): string {
  const s = raw?.trim();
  if (!s) return "";
  const range = RANGE.exec(s);
  if (range) {
    const from = timePart(range.slice(1, 6));
    const to = timePart(range.slice(6, 11));
    return from && to ? `${from} – ${to}` : s;
  }
  const one = ONE_TIME.exec(s);
  return (one && timePart(one.slice(1, 6))) || s;
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
