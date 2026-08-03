import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { FlowerExpenseFilters } from "@/components/finance/FlowerExpenseFilters";
import { FlowerExpenseTable } from "@/components/finance/FlowerExpenseTable";
import { ExpenseDialog } from "@/components/finance/FlowerExpenseForms";
import { listFlowerExpenses, resolveProfileFor, type DayStatus } from "@/modules/finance/flowerExpenses";
import { resolveExpensePeriod, yearOptions } from "@/modules/finance/expensePeriod";
import { saveExpenseAction, deleteExpenseAction, previewExpenseAction } from "./actions";

export const dynamic = "force-dynamic";

const PER_PAGE = 31;

/**
 * Полная история дневных расходов на цветы у владельца.
 *
 * Ограничения «последние N дней» здесь нет ни в выборке, ни в подсчёте итогов: месяц по
 * умолчанию — это стартовый фильтр, а не граница хранения, и «Вся история» лежит в том же
 * переключателе.
 */
export default async function FlowerExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireRole("OWNER");
  const sp = await searchParams;

  const profile = await resolveProfileFor({ userId: user.id, role: user.role });
  if (!profile) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="Нет основного флориста"
            description="Дневные расходы привязаны к финансовому профилю PRIMARY. Задайте его в разделе «Флористы»."
          />
        </CardBody>
      </Card>
    );
  }

  const period = resolveExpensePeriod(sp);
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const status = (sp.status as DayStatus | undefined) || null;

  const [list, earliest, todayRow, monthList] = await Promise.all([
    listFlowerExpenses(
      profile.id,
      profile.floristId,
      { from: period.from, to: period.to, query: sp.q ?? null, status },
      { page, perPage: PER_PAGE }
    ),
    prisma.dailyFlowerExpense.findFirst({
      where: { financeProfileId: profile.id },
      orderBy: { expenseDay: "asc" },
      select: { expenseDay: true },
    }),
    prisma.dailyFlowerExpense.findUnique({
      where: {
        financeProfileId_expenseDay: {
          financeProfileId: profile.id,
          expenseDay: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
        },
      },
      select: { amountCents: true },
    }),
    // Верхние показатели описывают текущий месяц независимо от выбранного фильтра:
    // иначе «расход за месяц» менялся бы при пролистывании прошлого года.
    listFlowerExpenses(
      profile.id,
      profile.floristId,
      resolveExpensePeriod({}),
      { page: 1, perPage: 1 }
    ),
  ]);

  const actions = { save: saveExpenseAction, remove: deleteExpenseAction, preview: previewExpenseAction };
  const totalPages = Math.max(Math.ceil(list.totalDays / PER_PAGE), 1);

  const pageHref = (n: number) => {
    const q = new URLSearchParams(Object.entries(sp).filter(([, v]) => v != null) as [string, string][]);
    q.set("page", String(n));
    return `/dashboard/finance/flower-expenses?${q.toString()}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Расходы на цветы"
        description={`Дневная закупка основного флориста — ${profile.floristName}. Полная история, без ограничения по давности.`}
        actions={<ExpenseDialog actions={actions} trigger="Добавить расход" variant="default" size="default" />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Сегодня" value={todayRow ? formatCents(todayRow.amountCents) : "не внесён"} tone={todayRow ? "default" : "warning"} />
        <StatCard label="Текущий месяц" value={formatCents(monthList.totals.expenseCents)} />
        <StatCard label="Средний за день" value={formatCents(monthList.totals.averagePerFilledDayCents)} />
        <StatCard
          label="Дней без заполнения"
          value={monthList.totals.daysMissing}
          tone={monthList.totals.daysMissing > 0 ? "danger" : "success"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>
            {period.label} · дней {list.totalDays} · закупка {formatCents(list.totals.expenseCents)}
          </CardTitle>
          <FlowerExpenseFilters years={yearOptions(earliest?.expenseDay ?? null)} />
        </CardHeader>
        <CardBody className="p-0">
          {list.rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="За выбранный период ничего нет"
                description="Ни расходов, ни доставленных заказов основного флориста. Смените период или выберите «Вся история»."
              />
            </div>
          ) : (
            <FlowerExpenseTable rows={list.rows} actions={actions} hrefBase="/dashboard/finance/flower-expenses" />
          )}
        </CardBody>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Страница {list.page} из {totalPages}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" disabled={list.page <= 1}>
                <Link href={pageHref(list.page - 1)}>Назад</Link>
              </Button>
              <Button asChild variant="outline" size="sm" disabled={list.page >= totalPages}>
                <Link href={pageHref(list.page + 1)}>Вперёд</Link>
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-400">
        Остаток — доля дневной закупки, зарезервированная за заказами, которые в расчёт не попали. Пока он не нулевой,
        день посчитан не полностью: причина будет в разделе «Требует заполнения».
      </p>
    </div>
  );
}
