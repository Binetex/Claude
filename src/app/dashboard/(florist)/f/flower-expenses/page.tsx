import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
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

  const [list, earliest] = await Promise.all([
    listFlowerExpenses(
      profile.id,
      profile.floristId,
      { from: period.from, to: period.to, query: null, status },
      { page, perPage: PER_PAGE }
    ),
    prisma.dailyFlowerExpense.findFirst({
      where: { financeProfileId: profile.id },
      orderBy: { expenseDay: "asc" },
      select: { expenseDay: true },
    }),
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
        actions={<ExpenseDialog actions={actions} trigger="Добавить расход" variant="default" size="default" />}
      />

      <Card>
        <CardHeader className="space-y-3">
          <FlowerExpenseFilters years={yearOptions(earliest?.expenseDay ?? null)} />
          {/* Единственная сводка, которая тут нужна: сколько потрачено за выбранный период. */}
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-slate-500">
              {period.label} · дней {list.totalDays}
            </span>
            <span className="text-xl font-semibold text-slate-900 tabular-nums">
              {formatCents(list.totals.expenseCents)}
            </span>
          </div>
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
    </div>
  );
}
