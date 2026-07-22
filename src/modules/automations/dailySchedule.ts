import { zonedLocalTimeToUtc, DEFAULT_STORE_TZ } from "@/lib/tz";

/**
 * Момент (UTC), когда должен сработать ежедневный триггер по локальному дню и времени магазина.
 * Чистая функция — вся таймзонная арифметика тестируется без БД.
 *
 * `localDay` — "YYYY-MM-DD" локального дня (для Order.deliveryDate это его UTC-календарная дата:
 * поле хранит UTC-полночь ЛОКАЛЬНОГО дня, пере-конвертация через tz сдвинула бы день).
 *
 * Если рассчитанный момент уже прошёл — возвращаем `now`: заказ на сегодня, созданный позже
 * времени рассылки, всё равно получает сообщение, а не теряет его до завтра.
 */
export function computeDailyTriggerAt(
  localDay: string,
  localTime: string | null | undefined,
  tz: string | null | undefined,
  now: Date = new Date()
): Date {
  const at = zonedLocalTimeToUtc(localDay, localTime || "09:00", tz || DEFAULT_STORE_TZ);
  return at.getTime() <= now.getTime() ? now : at;
}

/** Локальный день доставки для Order.deliveryDate (UTC-полночь локального дня). */
export function deliveryLocalDay(deliveryDate: Date): string {
  return deliveryDate.toISOString().slice(0, 10);
}
