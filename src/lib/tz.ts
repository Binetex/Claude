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
