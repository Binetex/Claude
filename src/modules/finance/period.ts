/**
 * Период страницы «Магазины». Чистая функция без БД: её поведение — часть контракта UI,
 * и проверять его тестом должно быть можно, не поднимая ни страницу, ни базу.
 *
 * Границы — UTC-полночь первого и последнего дня, та же конвенция, что у
 * `Order.deliveryDate`. Приводить их к таймзоне магазина НЕЛЬЗЯ: она уже учтена при записи
 * даты доставки, и повторный перевод сдвинул бы обе границы на сутки.
 *
 * А вот «какой сегодня день» — вопрос местного времени магазина, поэтому точка отсчёта
 * берётся через таймзону магазина: в полночь по UTC в Лос-Анджелесе ещё вчера.
 */
import { localDateStr, DEFAULT_STORE_TZ } from "@/lib/tz";

export type PeriodKind = "today" | "yesterday" | "week" | "month" | "range";

export type FinancePeriod = {
  kind: PeriodKind;
  from: Date;
  to: Date;
  label: string;
};

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** Именительный падеж — для заголовка месяца («август 2026»). */
const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const shift = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

/** «1 августа 2026» — календарная дата, без пересчёта через таймзону. */
export const dayLabel = (d: Date) => `${d.getUTCDate()} ${MONTHS_GENITIVE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

function parseIsoDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = utcDay(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const PERIOD_TABS: { key: PeriodKind; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "yesterday", label: "Вчера" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
];

/**
 * По умолчанию — текущий месяц: с вопроса «как идёт месяц» на эту страницу и заходят.
 *
 * «Неделя» — последние 7 дней, включая сегодня, а не календарная неделя: в понедельник
 * календарная неделя состоит из одного дня и сравнивать магазины по ней бессмысленно.
 */
export function resolvePeriod(
  sp: Record<string, string | undefined>,
  now: Date = new Date()
): FinancePeriod {
  const today = utcDay(localDateStr(now, DEFAULT_STORE_TZ));

  if (sp.period === "range") {
    const from = parseIsoDay(sp.from);
    const to = parseIsoDay(sp.to);
    // Незаданную границу достраиваем сегодняшним днём: выбрав в календаре только начало,
    // владелец имеет в виду «с этой даты по сейчас», а не один этот день.
    // Дальше границы сортируются — перевёрнутый диапазон даёт период, а не пустой экран.
    const [lo, hi] = [from ?? today, to ?? today].sort((a, b) => +a - +b);
    return {
      kind: "range",
      from: lo,
      to: hi,
      // Один и тот же день с обеих сторон — это выбранная дата, а не диапазон.
      label: +lo === +hi ? dayLabel(lo) : `${dayLabel(lo)} — ${dayLabel(hi)}`,
    };
  }

  if (sp.period === "today") return { kind: "today", from: today, to: today, label: dayLabel(today) };

  if (sp.period === "yesterday") {
    const y = shift(today, -1);
    return { kind: "yesterday", from: y, to: y, label: dayLabel(y) };
  }

  if (sp.period === "week") {
    const from = shift(today, -6);
    return { kind: "week", from, to: today, label: `${dayLabel(from)} — ${dayLabel(today)}` };
  }

  const from = utcDay(`${today.toISOString().slice(0, 7)}-01`);
  // Нулевой день следующего месяца — последний день текущего.
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return {
    kind: "month",
    from,
    to,
    label: `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`,
  };
}

/**
 * Все календарные дни периода включительно, «2026-08-01». UTC — как и сам `deliveryDate`.
 *
 * Дни без данных обязаны остаться в ряду: без них ось времени рвётся, и выходной выглядит
 * как «этого дня не было», а не как «в этот день не работали».
 */
export function eachDay(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** «2026-08-01» → «1 августа 2026». Для заголовка тултипа, где сокращение уже мешает. */
export function fullDayLabel(iso: string): string {
  return dayLabel(utcDay(iso));
}
