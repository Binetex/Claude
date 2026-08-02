import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
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
import { saveMyExpenseAction, deleteMyExpenseAction, previewMyExpenseAction } from "./actions";

export const dynamic = "force-dynamic";

const PER_PAGE = 31;

/**
 * Свои расходы на цветы в кабинете основного флориста.
 *
 * В маршруте нет ни floristId, ни profileId — как и на остальных страницах кабинета.
 * Профиль резолвится из сессии, и если он не PRIMARY, страница честно говорит, что
 * раздел не про этого флориста, вместо того чтобы показать чужие или пустые данные.
 *
 * Владельческих величин здесь нет ни одной: ни налоговой политики, ни фактической прибыли
 * владельца, ни данных других флористов. Показаны только закупка, её распределение по её
 * собственным заказам и признак того, вошла ли она в расчёт.
 */
export default async function MyFlowerExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;

  const profile = await resolveProfileFor({ userId: user.id, role: user.role, floristId: user.floristId });
  if (!profile) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="Раздел недоступен"
            description="Дневные расходы на цветы ведёт основной флорист. По вашему профилю закупка не учитывается."
          />
        </CardBody>
      </Card>
    );
  }

  const period = resolveExpensePeriod(sp);
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const status = (sp.status as DayStatus | undefined) || null;

  const [list, earliest, monthList] = await Promise.all([
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
    listFlowerExpenses(profile.id, profile.floristId, resolveExpensePeriod({}), { page: 1, perPage: 1 }),
  ]);

  const actions = { save: saveMyExpenseAction, remove: deleteMyExpenseAction, preview: previewMyExpenseAction };
  const totalPages = Math.max(Math.ceil(list.totalDays / PER_PAGE), 1);

  const pageHref = (n: number) => {
    const q = new URLSearchParams(Object.entries(sp).filter(([, v]) => v != null) as [string, string][]);
    q.set("page", String(n));
    return `/dashboard/f/flower-expenses?${q.toString()}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Расходы на цветы"
        description="Дневная закупка: вычитается из выручки дня и делится между вашими заказами."
        actions={<ExpenseDialog actions={actions} trigger="Добавить расход" variant="default" size="default" />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Текущий месяц" value={formatCents(monthList.totals.expenseCents)} />
        <StatCard label="Средний за день" value={formatCents(monthList.totals.averagePerFilledDayCents)} />
        <StatCard
          label="Дней без заполнения"
          value={monthList.totals.daysMissing}
          tone={monthList.totals.daysMissing > 0 ? "warning" : "success"}
        />
        <StatCard label="Дней с закупкой" value={monthList.totals.daysFilled} />
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
              <EmptyState title="За выбранный период ничего нет" description="Смените период или выберите «Вся история»." />
            </div>
          ) : (
            <FlowerExpenseTable rows={list.rows} actions={actions} hrefBase="/dashboard/f/flower-expenses" compact />
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
        «В расчёте» означает, что за этот день уже начислена ваша доля. Исправление суммы за такой день пересчитает
        начисление — прежнее будет сторновано, а новое создано.
      </p>
    </div>
  );
}
