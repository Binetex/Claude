/**
 * Таблица истории дневных расходов. Общая для владельца и флориста.
 *
 * Дни без внесённого расхода показываются наравне с заполненными: главный вопрос к этой
 * таблице — «что я пропустил», а пропущенное по определению отсутствует в записях.
 *
 * `compact` убирает служебные колонки авторства у флориста: там всё равно только два
 * возможных автора, и ширина уходит на них зря.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { formatCents } from "@/lib/cents";
import { ExpenseDialog, DeleteExpenseDialog, type ExpenseActions } from "./FlowerExpenseForms";
import type { DayStatus, FlowerExpenseRow } from "@/modules/finance/flowerExpenses";

const statusMeta: Record<DayStatus, { label: string; className: string }> = {
  COUNTED: { label: "Посчитан", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  FILLED: { label: "Заполнено", className: "border-slate-200 bg-slate-50 text-slate-600" },
  INCOMPLETE: { label: "Не хватает данных", className: "border-amber-200 bg-amber-50 text-amber-800" },
  MISSING: { label: "Отсутствует", className: "border-red-200 bg-red-50 text-red-700" },
};

const dt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export function FlowerExpenseTable({
  rows,
  actions,
  hrefBase,
  compact = false,
}: {
  rows: FlowerExpenseRow[];
  actions: ExpenseActions;
  hrefBase: string;
  compact?: boolean;
}) {
  return (
    <>
      {/* Телефон: карточка на день вместо строки таблицы. В восьми колонках кнопка «Внести»
          оказывалась крайней справа, и внести закупку можно было только домотав таблицу вбок —
          то есть ровно то действие, ради которого на страницу и заходят, было спрятано. */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((r) => (
          <li key={r.day} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`${hrefBase}/${r.day}`} className="font-medium text-slate-800 tabular-nums hover:underline">
                  {r.day}
                </Link>
                <div className="mt-1">
                  <Badge className={statusMeta[r.status].className}>{statusMeta[r.status].label}</Badge>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-base font-semibold text-slate-900 tabular-nums">
                  {r.expense ? formatCents(r.expense.amountCents) : <span className="text-slate-300">—</span>}
                </div>
                <div className="text-xs text-slate-400 tabular-nums">заказов {r.ordersTotal}</div>
              </div>
            </div>

            {r.expense?.comment && <p className="mt-1 truncate text-xs text-slate-500">{r.expense.comment}</p>}

            <div className="mt-2 flex items-center gap-2">
              <ExpenseDialog
                actions={actions}
                trigger={r.expense ? "Изменить" : "Внести"}
                day={r.day}
                amountCents={r.expense?.amountCents ?? null}
                comment={r.expense?.comment ?? null}
                variant={r.expense ? "outline" : "default"}
                className="flex-1"
              />
              {r.expense && <DeleteExpenseDialog actions={actions} day={r.day} />}
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
            <th className="px-4 py-2.5 font-medium">Дата</th>
            <th className="px-3 py-2.5 font-medium">Статус</th>
            <th className="px-3 py-2.5 text-right font-medium">Закупка</th>
            <th className="px-3 py-2.5 font-medium">Комментарий</th>
            <th className="px-3 py-2.5 text-right font-medium">Заказов</th>
            {!compact && (
              <>
                <th className="px-3 py-2.5 font-medium">Создал</th>
                <th className="px-3 py-2.5 font-medium">Изменил</th>
              </>
            )}
            <th className="px-4 py-2.5 text-right font-medium">Действия</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
              <td className="px-4 py-2.5 tabular-nums">
                <Link href={`${hrefBase}/${r.day}`} className="font-medium text-slate-800 hover:underline">
                  {r.day}
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <Badge className={statusMeta[r.status].className}>{statusMeta[r.status].label}</Badge>
              </td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                {r.expense ? formatCents(r.expense.amountCents) : <span className="text-slate-300">—</span>}
              </td>
              <td className="max-w-56 truncate px-3 py-2.5 text-slate-500" title={r.expense?.comment ?? ""}>
                {r.expense?.comment ?? ""}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{r.ordersTotal}</td>
              {!compact && (
                <>
                  <td className="px-3 py-2.5 text-xs text-slate-500">
                    {r.expense ? (
                      <>
                        {r.expense.createdByName ?? "—"}
                        <div className="text-slate-400 tabular-nums">{dt(r.expense.createdAt)}</div>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">
                    {r.expense?.updatedBy ? (
                      <>
                        {r.expense.updatedByName ?? "—"}
                        <div className="text-slate-400 tabular-nums">{dt(r.expense.updatedAt)}</div>
                      </>
                    ) : (
                      <span className="text-slate-300">не менялась</span>
                    )}
                  </td>
                </>
              )}
              <td className="px-4 py-2 text-right whitespace-nowrap">
                <div className="flex items-center justify-end gap-1">
                  <ExpenseDialog
                    actions={actions}
                    trigger={r.expense ? "Изменить" : "Внести"}
                    day={r.day}
                    amountCents={r.expense?.amountCents ?? null}
                    comment={r.expense?.comment ?? null}
                  />
                  {r.expense && <DeleteExpenseDialog actions={actions} day={r.day} />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
