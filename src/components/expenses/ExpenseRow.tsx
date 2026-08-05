/**
 * Строка расхода: когда · что · сколько, и скрытое меню действий.
 *
 * Три колонки фиксированной ширины по краям и гибкая середина — так даты стоят под датами,
 * суммы под суммами, и глаз читает столбец, а не ищет число в каждой строке заново.
 */
import { formatCents } from "@/lib/cents";
import { RowActions } from "./RowActions";
import { entryDateLabel } from "./entryDate";
import type { ExpenseActions, ExpenseCategoryDto } from "./ExpenseForms";
import type { ExpenseEntry } from "@/modules/expenses/read";

export function ExpenseRow({
  entry,
  cents,
  categories,
  actions,
  /** Категория показывается в ленте истории, где строки идут вперемешку. */
  showCategory = false,
}: {
  entry: ExpenseEntry;
  cents: number;
  categories: ExpenseCategoryDto[];
  actions: ExpenseActions;
  showCategory?: boolean;
}) {
  return (
    <div className="group flex items-center gap-3 py-1.5">
      <span className="w-16 shrink-0 text-xs tabular-nums text-slate-400">{entryDateLabel(entry)}</span>

      <div className="min-w-0 flex-1">
        <span className="text-sm text-slate-800">{entry.label}</span>
        {showCategory && (
          <span className="ml-2 text-xs text-slate-400">
            {entry.categoryName}
            {entry.subcategoryName && entry.subcategoryName !== entry.label ? ` · ${entry.subcategoryName}` : ""}
          </span>
        )}
      </div>

      <span className="w-20 shrink-0 text-right text-sm tabular-nums text-slate-800 sm:w-24">{formatCents(cents)}</span>

      <RowActions
        actions={actions}
        categories={categories}
        label={entry.label}
        edit={{
          id: entry.id,
          categoryId: entry.categoryId,
          subcategoryId: entry.subcategoryId,
          title: entry.title,
          amountCents: entry.amountCents,
          kind: entry.kind,
          startDay: entry.startDay,
          endDay: entry.endDay,
        }}
      />
    </div>
  );
}
