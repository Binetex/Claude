/**
 * Размазывание расхода по дням. Чистые функции: ни БД, ни сети, ни текущего времени.
 *
 * ЗАЧЕМ. Владелец хочет видеть РОВНЫЙ дневной расход, а не всплеск в день оплаты: хостинг
 * за $63 в месяц должен читаться как $2.10 каждый день. Поэтому в базе лежит ПРАВИЛО
 * (сумма + срок), а суммы по дням выводятся при чтении. Правка правила мгновенно меняет
 * все затронутые дни — нет ни backfill, ни истории, разошедшейся с настройкой.
 *
 * Смысл суммы задаёт вид расхода:
 *   ONE_OFF — разовый, вся сумма в один день;
 *   DAILY   — сумма ЗА ДЕНЬ, повторяется каждый день срока;
 *   MONTHLY — сумма ЗА МЕСЯЦ, делится на активные дни каждого месяца;
 *   RANGE   — сумма ЗА ВЕСЬ СРОК, делится на все дни срока.
 *
 * Деньги — целые центы (конвенция финансового модуля). При делении остаток раздаётся по
 * центу первым дням: сумма дней всегда в точности равна исходной, без «потерянных» центов.
 */

export type ExpenseKind = "ONE_OFF" | "DAILY" | "MONTHLY" | "RANGE";

export type ExpenseRule = {
  id: string;
  kind: ExpenseKind;
  amountCents: number;
  startDay: Date;
  /** null — бессрочно (для DAILY/MONTHLY) либо неприменимо (ONE_OFF). */
  endDay: Date | null;
};

/** Начисление правила на один день. */
export type DayPortion = { ruleId: string; day: string; cents: number };

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const utcDay = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const DAY_MS = 86_400_000;

/** UTC-полночь: входные даты могут прийти с временем, дни сравниваем календарно. */
function floorDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
}

/**
 * Делит сумму на n частей так, чтобы их сумма в точности равнялась исходной.
 * Остаток от деления раздаётся по центу первым частям — иначе на длинных сроках
 * терялись бы центы, и месяц не сходился бы с суммой своих дней.
 */
export function splitCents(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Пересечение срока правила с окном [from, to]; null — не пересекаются. */
function activeWindow(rule: ExpenseRule, from: Date, to: Date): { start: Date; end: Date } | null {
  const ruleStart = floorDay(rule.startDay);
  // ONE_OFF живёт ровно один день, даже если endDay кем-то заполнен.
  const ruleEnd = rule.kind === "ONE_OFF" ? ruleStart : rule.endDay ? floorDay(rule.endDay) : null;

  const start = ruleStart > from ? ruleStart : from;
  const end = ruleEnd == null ? to : ruleEnd < to ? ruleEnd : to;
  return start > end ? null : { start, end };
}

/**
 * Раскладывает одно правило по дням окна [from, to] включительно.
 *
 * Окно — это ТОЛЬКО то, что показываем; на размер дневной доли оно не влияет. Для MONTHLY
 * доля считается по активным дням КАЛЕНДАРНОГО месяца, а не по видимому куску: иначе
 * открытие полумесяца завышало бы дневной расход.
 */
export function allocateRule(rule: ExpenseRule, from: Date, to: Date): DayPortion[] {
  const win = activeWindow(rule, floorDay(from), floorDay(to));
  if (!win) return [];

  if (rule.kind === "ONE_OFF") {
    return [{ ruleId: rule.id, day: isoDay(win.start), cents: rule.amountCents }];
  }

  if (rule.kind === "DAILY") {
    const out: DayPortion[] = [];
    for (let d = win.start; d <= win.end; d = addDays(d, 1)) {
      out.push({ ruleId: rule.id, day: isoDay(d), cents: rule.amountCents });
    }
    return out;
  }

  if (rule.kind === "RANGE") {
    // Знаменатель — ВЕСЬ срок правила, а не видимая его часть.
    const ruleStart = floorDay(rule.startDay);
    const ruleEnd = rule.endDay ? floorDay(rule.endDay) : ruleStart;
    const parts = splitCents(rule.amountCents, daysBetween(ruleStart, ruleEnd));
    const out: DayPortion[] = [];
    for (let d = win.start; d <= win.end; d = addDays(d, 1)) {
      const idx = Math.round((d.getTime() - ruleStart.getTime()) / DAY_MS);
      out.push({ ruleId: rule.id, day: isoDay(d), cents: parts[idx] ?? 0 });
    }
    return out;
  }

  // MONTHLY: сумма за месяц делится на активные дни ЭТОГО месяца.
  const ruleStart = floorDay(rule.startDay);
  const ruleEnd = rule.endDay ? floorDay(rule.endDay) : null;
  const out: DayPortion[] = [];

  let cursor = new Date(Date.UTC(win.start.getUTCFullYear(), win.start.getUTCMonth(), 1));
  while (cursor <= win.end) {
    const monthStart = cursor;
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));

    // Активные дни месяца: месяц ∩ срок правила. Правило, начавшееся 15-го, получает
    // за этот месяц полную месячную сумму, размазанную по оставшимся дням — так и
    // происходит на самом деле: платёж за месяц один, начался он в середине.
    const activeStart = ruleStart > monthStart ? ruleStart : monthStart;
    const activeEnd = ruleEnd && ruleEnd < monthEnd ? ruleEnd : monthEnd;

    if (activeStart <= activeEnd) {
      const parts = splitCents(rule.amountCents, daysBetween(activeStart, activeEnd));
      for (let d = activeStart; d <= activeEnd; d = addDays(d, 1)) {
        if (d < win.start || d > win.end) continue; // за пределами показываемого окна
        const idx = Math.round((d.getTime() - activeStart.getTime()) / DAY_MS);
        out.push({ ruleId: rule.id, day: isoDay(d), cents: parts[idx] ?? 0 });
      }
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

/** Все дни окна включительно — таблица показывает и пустые дни («что я пропустил»). */
export function daysInWindow(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let d = floorDay(from); d <= floorDay(to); d = addDays(d, 1)) out.push(isoDay(d));
  return out;
}
