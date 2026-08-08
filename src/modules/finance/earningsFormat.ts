/**
 * Подписи экранов заработка. Обычный модуль (не "use server", не "server-only"):
 * одни и те же строки нужны и серверным страницам, и клиентским кускам.
 */

const DAY_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const MONTH_FMT = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

/** «3 августа» из ключа YYYY-MM-DD. Формат в UTC: ключ и есть календарный день. */
export function formatDayLong(dayKey: string): string {
  return DAY_FMT.format(new Date(`${dayKey}T00:00:00.000Z`));
}

/** «Август 2026» — заголовок группы в истории выплат. */
export function formatMonthTitle(date: Date): string {
  // ru-RU добавляет « г.» — в заголовке это шум, убираем.
  const s = MONTH_FMT.format(date).replace(/\s*г\.$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «3 заказа» — русские окончания, иначе интерфейс выглядит машинным переводом. */
export function pluralOrders(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} заказов`;
  if (mod10 === 1) return `${n} заказ`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} заказа`;
  return `${n} заказов`;
}

/**
 * Доля величины в выручке: «43%». Нужна, чтобы понимать не абсолютные суммы, а кто сколько
 * съедает — расходы, флористы, я.
 *
 * NULL, когда процент был бы ложью:
 *  - выручки нет (делить не на что). Ноль выручки при непустом расходе — это не «0%»;
 *  - сама величина неизвестна (день не посчитан) — там и суммы нет, стоит прочерк.
 *
 * Знак сохраняется: убыточный день честно показывает «−31%».
 */
export function shareOfRevenue(cents: number | null | undefined, revenueCents: number): string | null {
  if (cents == null || revenueCents <= 0) return null;
  return `${Math.round((cents / revenueCents) * 100)}%`;
}
