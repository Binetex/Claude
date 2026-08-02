/**
 * Разбор периода из query-параметров страницы расходов.
 *
 * Чистая функция без БД: её поведение — часть контракта UI, и проверять его тестом
 * должно быть можно, не поднимая ни страницу, ни базу.
 *
 * Границы считаются в UTC, потому что expenseDay — UTC-полночь локального дня (та же
 * конвенция, что у Order.deliveryDate). Приводить их к таймзоне магазина нельзя: месяц
 * съедет на сутки на обеих границах.
 */
export type ExpensePeriod = {
  kind: "month" | "year" | "range" | "all";
  from: Date | null;
  to: Date | null;
  label: string;
};

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

function parseIsoDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * По умолчанию — текущий месяц: он отвечает на вопрос «что я ещё не заполнил», с которым
 * на эту страницу и приходят. «Вся история» доступна тем же переключателем и ничего не
 * скрывает — ограничение здесь только на то, что показано, и никогда на то, что хранится.
 */
export function resolveExpensePeriod(
  sp: Record<string, string | undefined>,
  now: Date = new Date()
): ExpensePeriod {
  const kind = sp.period === "year" || sp.period === "range" || sp.period === "all" ? sp.period : "month";

  if (kind === "all") return { kind, from: null, to: null, label: "вся история" };

  if (kind === "range") {
    const from = parseIsoDay(sp.from);
    const to = parseIsoDay(sp.to);
    return {
      kind,
      from,
      to,
      label: from || to ? `${from ? from.toISOString().slice(0, 10) : "…"} — ${to ? to.toISOString().slice(0, 10) : "…"}` : "период не задан",
    };
  }

  const year = Number(sp.year) || now.getUTCFullYear();

  if (kind === "year") {
    return { kind, from: utcDay(year, 0, 1), to: utcDay(year, 11, 31), label: String(year) };
  }

  // Любое значение вне 1..12 — это мусор в адресе, а не «почти правильный» месяц.
  // Зажимать его к декабрю значило бы показать данные, которых не просили; честнее
  // вернуться к текущему месяцу, как при отсутствии параметра.
  const raw = Number(sp.month);
  const month = Number.isInteger(raw) && raw >= 1 && raw <= 12 ? raw : now.getUTCMonth() + 1;
  return {
    kind,
    from: utcDay(year, month - 1, 1),
    // Нулевой день следующего месяца — последний день текущего, без таблицы длин месяцев
    // и без високосных исключений.
    to: utcDay(year, month, 0),
    label: `${MONTHS[month - 1]} ${year}`,
  };
}

/** Годы для выпадающего списка: от первого года с данными по текущий. */
export function yearOptions(earliest: Date | null, now: Date = new Date()): number[] {
  const last = now.getUTCFullYear();
  const first = earliest ? earliest.getUTCFullYear() : last;
  const out: number[] = [];
  for (let y = last; y >= Math.min(first, last); y--) out.push(y);
  return out;
}
