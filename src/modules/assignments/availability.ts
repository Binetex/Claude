/**
 * Доступность флориста на дату доставки. Чистые функции: ни Prisma, ни «сейчас».
 *
 * ДАТА БЕРЁТСЯ КАК ЕСТЬ. `Order.deliveryDate` — это уже UTC-полночь ЛОКАЛЬНОГО дня
 * доставки, то есть бизнес-дата проекта, а не момент времени. Поэтому день недели читается
 * через `getUTCDay()`, а даты сравниваются по UTC-календарю.
 *
 * Пропустить `deliveryDate` через таймзону магазина здесь НЕЛЬЗЯ: она уже учтена при записи,
 * и повторный перевод сдвинул бы день на сутки — флорист оказался бы выходным не в тот день.
 * Та же ловушка описана в lib/tz.ts и в CLAUDE.md.
 */

/** Что нужно знать о флористе, чтобы ответить на вопрос. */
export type FloristAvailability = {
  /** 0 = воскресенье … 6 = суббота. */
  weekendDays: number[];
  daysOff: Date[];
};

/** Календарный день в UTC как «YYYY-MM-DD». */
export function businessDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Свободен ли флорист в этот день доставки.
 *
 * Пустые настройки означают «работает всегда» — новый флорист доступен сразу, ничего
 * заполнять не нужно.
 */
export function isFloristAvailable(florist: FloristAvailability, deliveryDate: Date): boolean {
  if (florist.weekendDays.includes(deliveryDate.getUTCDay())) return false;
  const key = businessDayKey(deliveryDate);
  return !florist.daysOff.some((d) => businessDayKey(d) === key);
}

export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Понедельник" },
  { value: 2, label: "Вторник" },
  { value: 3, label: "Среда" },
  { value: 4, label: "Четверг" },
  { value: 5, label: "Пятница" },
  { value: 6, label: "Суббота" },
  { value: 0, label: "Воскресенье" },
];
