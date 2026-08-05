/**
 * Лента истории: все записи за всё время, свежие сверху, сгруппированные по дате.
 *
 * Существует ради вопросов, на которые месячная сводка не отвечает: «платил ли я за домен
 * месяц назад», «когда последний раз платил OpenAI». Поэтому лента НЕ ограничена выбранным
 * месяцем — иначе она отвечала бы на тот же вопрос, что и первая вкладка.
 *
 * Сумма здесь — исходная сумма записи, а не вклад в какой-то месяц: лента про сам факт
 * расхода, а не про его распределение.
 */
import { formatCents } from "@/lib/cents";
import { ExpenseRow } from "./ExpenseRow";
import { shortDate } from "./entryDate";
import type { ExpenseActions, ExpenseCategoryDto } from "./ExpenseForms";
import type { ExpenseEntry } from "@/modules/expenses/read";

/** «5 августа 2026» — заголовок дня. Год нужен: лента идёт за всё время. */
const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function dayHeading(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS_GENITIVE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function HistoryList({
  entries,
  categoryOptions,
  actions,
}: {
  entries: ExpenseEntry[];
  categoryOptions: ExpenseCategoryDto[];
  actions: ExpenseActions;
}) {
  // Группируем по дню начала: у повторяющихся это день, с которого расход существует.
  const days: { day: string; items: ExpenseEntry[] }[] = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last && last.day === e.startDay) last.items.push(e);
    else days.push({ day: e.startDay, items: [e] });
  }

  return (
    <ul className="divide-y divide-slate-100">
      {days.map((d) => (
        <li key={d.day} className="px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">{dayHeading(d.day)}</span>
            <span className="text-xs tabular-nums text-slate-400">
              {formatCents(d.items.reduce((a, i) => a + i.amountCents, 0))}
            </span>
          </div>
          <div className="mt-0.5">
            {d.items.map((e) => (
              <ExpenseRow
                key={e.id}
                entry={e}
                cents={e.amountCents}
                categories={categoryOptions}
                actions={actions}
                showCategory
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export { shortDate };
