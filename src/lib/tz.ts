// Таймзона магазина по умолчанию (если у сайта не проставлена Site.timezone). O'Hara — США.
export const DEFAULT_STORE_TZ = "America/Los_Angeles";

/** Календарная дата (YYYY-MM-DD) переданного момента в указанной таймзоне. */
export function localDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Сегодняшняя дата (YYYY-MM-DD) в таймзоне магазина. */
export function todayStrInTz(tz: string | null | undefined): string {
  return localDateStr(new Date(), tz || DEFAULT_STORE_TZ);
}

/** true, если строка — валидная IANA-таймзона. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC-диапазон [gte, lt) для СЕГОДНЯШНЕГО календарного дня в таймзоне `tz`.
 * deliveryDate хранится как UTC-полночь локального дня, поэтому фильтр `deliveryDate >= gte &&
 * deliveryDate < lt` корректно выбирает «сегодня по местному времени магазина». Ключевое: когда
 * в UTC уже следующие сутки, а в tz ещё предыдущие, `localDateStr` вернёт локальную дату (предыдущую),
 * и диапазон нацелится на правильный локальный день (см. req о границе суток).
 */
export function utcDayRangeForLocalToday(tz: string | null | undefined, now: Date = new Date()): { gte: Date; lt: Date } {
  const dateStr = localDateStr(now, tz || DEFAULT_STORE_TZ); // "YYYY-MM-DD" в местной зоне
  const gte = new Date(`${dateStr}T00:00:00.000Z`);
  const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
}

/**
 * Классифицирует `deliveryDate` (UTC-полночь локального дня) относительно СЕГОДНЯ в таймзоне `tz`.
 * Чистый строительный блок для БУДУЩЕГО per-site расчёта метрик «Сегодня/Завтра»: когда магазины
 * окажутся в разных часовых поясах, счётчики нужно считать по `Site.timezone` КАЖДОГО магазина
 * (сгруппировать заказы по зоне → классифицировать → просуммировать), а не по одному глобальному tz.
 * См. TODO в modules/orders/metrics.ts. Сейчас в проде это не используется (все магазины — LA).
 */
export function deliveryDayBucket(
  deliveryDate: Date,
  tz: string | null | undefined,
  now: Date = new Date()
): "today" | "tomorrow" | "other" {
  const today = utcDayRangeForLocalToday(tz, now);
  const tomorrowLt = new Date(today.lt.getTime() + 24 * 60 * 60 * 1000);
  if (deliveryDate >= today.gte && deliveryDate < today.lt) return "today";
  if (deliveryDate >= today.lt && deliveryDate < tomorrowLt) return "tomorrow";
  return "other";
}
