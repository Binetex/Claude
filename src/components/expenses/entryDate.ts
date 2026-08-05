/**
 * Дата записи для колонки «когда».
 *
 * Колонка обязана что-то говорить у КАЖДОЙ записи, иначе она перестаёт читаться как
 * столбец. У разового расхода это его день; у периода — обе границы; у повторяющегося
 * одного дня не существует вовсе, поэтому там стоит периодичность, а не выдуманная дата.
 */
import type { ExpenseKind } from "@/modules/expenses/spread";

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «04 авг» — день с ведущим нулём, чтобы даты стояли ровным столбцом. */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

export function entryDateLabel(entry: { kind: ExpenseKind; startDay: string; endDay: string | null }): string {
  switch (entry.kind) {
    case "ONE_OFF":
      return shortDate(entry.startDay);
    case "RANGE": {
      if (!entry.endDay) return shortDate(entry.startDay);
      const sameMonth = entry.startDay.slice(0, 7) === entry.endDay.slice(0, 7);
      // В пределах месяца название месяца дважды — лишний шум: «03–12 авг».
      const left = sameMonth ? String(new Date(`${entry.startDay}T00:00:00.000Z`).getUTCDate()).padStart(2, "0") : shortDate(entry.startDay);
      return `${left}–${shortDate(entry.endDay)}`;
    }
    case "MONTHLY":
      return "ежемес.";
    case "DAILY":
      return "ежедн.";
    default:
      return shortDate(entry.startDay);
  }
}
