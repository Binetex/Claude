/**
 * Месячная сводка: свёрнутый список категорий.
 *
 * Закрыт по умолчанию — экран отвечает за ОБЗОР. В свёрнутом виде видно ровно то, за чем
 * на него приходят: название, сумма и сколько внутри записей. Раскрытие показывает историю
 * категории; она нужна не всегда, поэтому и не занимает место постоянно.
 *
 * Свёртка на `<details>`, без состояния и без библиотек: раскрытые категории переживают
 * перерисовку после правки расхода, а с useState схлопывались бы обратно.
 */
import { ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/cents";
import { ExpenseRow } from "./ExpenseRow";
import type { ExpenseActions, ExpenseCategoryDto } from "./ExpenseForms";
import type { MonthCategory } from "@/modules/expenses/read";
import { pluralRu } from "@/lib/plural";

/** «3 записи» — подсказка, стоит ли вообще раскрывать. */
function countLabel(n: number): string {
  return `${n} ${pluralRu(n, "запись", "записи", "записей")}`;
}

export function CategoryList({
  categories,
  totalCents,
  categoryOptions,
  actions,
}: {
  categories: MonthCategory[];
  totalCents: number;
  categoryOptions: ExpenseCategoryDto[];
  actions: ExpenseActions;
}) {
  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {categories.map((cat) => (
          <li key={cat.id}>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-slate-50/60 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                />
                <span className="min-w-0 flex-1 font-medium text-slate-900">{cat.name}</span>
                <span className="shrink-0 text-xs text-slate-400">{countLabel(cat.entries.length)}</span>
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-slate-900 sm:w-24">
                  {formatCents(cat.cents)}
                </span>
                {/* Держит колонку меню: без неё суммы категорий не встают над суммами записей. */}
                <span className="w-7 shrink-0" aria-hidden />
              </summary>

              {/* Отступ ровно под стрелку — вложенность читается, но не «уезжает» вправо. */}
              <div className="pb-2 pl-11 pr-4">
                {cat.entries.map((e) => (
                  <ExpenseRow key={e.id} entry={e} cents={e.cents} categories={categoryOptions} actions={actions} />
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3">
        <span className="flex-1 pl-7 font-medium text-slate-700">Итого за месяц</span>
        <span className="w-20 shrink-0 text-right text-base font-semibold tabular-nums text-slate-900 sm:w-24 sm:text-lg">
          {formatCents(totalCents)}
        </span>
        <span className="w-7 shrink-0" aria-hidden />
      </div>
    </div>
  );
}
