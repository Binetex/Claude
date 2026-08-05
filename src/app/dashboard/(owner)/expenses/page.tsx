import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import { CategoryList } from "@/components/expenses/CategoryList";
import { HistoryList } from "@/components/expenses/HistoryList";
import { HistorySearch } from "@/components/expenses/HistorySearch";
import { ExpenseDialog } from "@/components/expenses/ExpenseForms";
import {
  getExpenseMonthSummary, getExpenseHistory, getExpenseTotal,
  listExpenseCategories, earliestExpenseDay,
} from "@/modules/expenses/read";
import { yearOptions } from "@/modules/finance/expensePeriod";
import { saveExpenseAction, deleteExpenseAction } from "./actions";

export const dynamic = "force-dynamic";

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/**
 * «Мои расходы». Две вкладки под два разных вопроса:
 *   Категории — сколько ушло за месяц и на что (обзор);
 *   История   — когда и за что я платил (поиск по всему времени).
 *
 * Разделены намеренно: месячная сводка не может ответить «платил ли я за домен месяц
 * назад», а лента за всё время не отвечает «сколько вышло в августе».
 *
 * Верхние карточки описывают текущие сегодня/месяц/год независимо от выбранного в фильтре
 * месяца: иначе «расход за год» менялся бы от листания прошлого августа.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;
  const tab = sp.tab === "history" ? "history" : "categories";

  const now = new Date();
  const year = Number(sp.year) || now.getUTCFullYear();
  const rawMonth = Number(sp.month);
  const month = Number.isInteger(rawMonth) && rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getUTCMonth() + 1;

  const from = utc(year, month - 1, 1);
  // Нулевой день следующего месяца — последний день текущего, без таблицы длин месяцев.
  const to = utc(year, month, 0);

  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = utc(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = utc(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
  const yearStart = utc(now.getUTCFullYear(), 0, 1);
  const yearEnd = utc(now.getUTCFullYear(), 11, 31);

  const [summary, history, categories, earliest, todayCents, monthCents, yearCents] = await Promise.all([
    tab === "categories" ? getExpenseMonthSummary(from, to) : Promise.resolve(null),
    tab === "history" ? getExpenseHistory(sp.q ?? null, Number(sp.page) || 1) : Promise.resolve(null),
    listExpenseCategories(),
    earliestExpenseDay(),
    getExpenseTotal(today, today),
    getExpenseTotal(monthStart, monthEnd),
    getExpenseTotal(yearStart, yearEnd),
  ]);

  const actions = { save: saveExpenseAction, remove: deleteExpenseAction };

  const tabHref = (next: "categories" | "history") => {
    const q = new URLSearchParams();
    if (next === "history") q.set("tab", "history");
    else {
      if (sp.month) q.set("month", sp.month);
      if (sp.year) q.set("year", sp.year);
    }
    const s = q.toString();
    return s ? `/dashboard/expenses?${s}` : "/dashboard/expenses";
  };

  const historyPages = history ? Math.max(Math.ceil(history.total / history.perPage), 1) : 1;
  const historyHref = (n: number) => {
    const q = new URLSearchParams();
    q.set("tab", "history");
    if (sp.q) q.set("q", sp.q);
    if (n > 1) q.set("page", String(n));
    return `/dashboard/expenses?${q.toString()}`;
  };

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-2 text-sm ${
      active ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"
    }`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Мои расходы"
        description="Сколько уходит и на что."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/expenses/categories">Категории</Link>
            </Button>
            <ExpenseDialog actions={actions} categories={categories} trigger="Добавить расход" variant="default" size="default" />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Расход сегодня" value={formatCents(todayCents)} />
        <StatCard label="Расход за месяц" value={formatCents(monthCents)} />
        <StatCard label="Расход за год" value={formatCents(yearCents)} />
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        <Link href={tabHref("categories")} className={tabClass(tab === "categories")}>
          Категории
        </Link>
        <Link href={tabHref("history")} className={tabClass(tab === "history")}>
          История
        </Link>
      </div>

      {tab === "categories" && summary && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              {MONTHS[month - 1]} {year} · {formatCents(summary.totalCents)}
            </CardTitle>
            <ExpenseFilters years={yearOptions(earliest)} />
          </CardHeader>
          <CardBody className={summary.categories.length === 0 ? undefined : "p-0"}>
            {summary.categories.length === 0 ? (
              <EmptyState
                title="В этом месяце расходов нет"
                description="Добавьте расход — повторяющиеся будут появляться здесь каждый месяц сами."
              />
            ) : (
              <CategoryList
                categories={summary.categories}
                totalCents={summary.totalCents}
                categoryOptions={categories}
                actions={actions}
              />
            )}
          </CardBody>
        </Card>
      )}

      {tab === "history" && history && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <HistorySearch />
            <span className="text-sm text-slate-400">
              {sp.q ? `найдено: ${history.total}` : `всего записей: ${history.total}`}
            </span>
          </CardHeader>
          <CardBody className={history.entries.length === 0 ? undefined : "p-0"}>
            {history.entries.length === 0 ? (
              <EmptyState
                title={sp.q ? "Ничего не нашлось" : "Расходов пока нет"}
                description={sp.q ? "Попробуйте другое слово — поиск идёт по названию, категории и подкатегории." : "Добавьте первый расход."}
              />
            ) : (
              <HistoryList entries={history.entries} categoryOptions={categories} actions={actions} />
            )}
          </CardBody>
          {historyPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
              <span className="text-slate-500">
                Страница {history.page} из {historyPages}
              </span>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm" disabled={history.page <= 1}>
                  <Link href={historyHref(history.page - 1)}>Назад</Link>
                </Button>
                <Button asChild variant="outline" size="sm" disabled={history.page >= historyPages}>
                  <Link href={historyHref(history.page + 1)}>Вперёд</Link>
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
