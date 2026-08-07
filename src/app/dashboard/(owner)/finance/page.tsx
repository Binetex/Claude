import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import { OwnerDayList } from "@/components/finance/OwnerDayList";
import { OwnerMonthChart } from "./OwnerMonthChart";
import { getOwnerMonth } from "@/modules/finance/ownerDashboard";
import { yearOptions } from "@/modules/finance/expensePeriod";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** «−12%» у прибыли: как выбранный месяц идёт против предыдущего. */
function deltaLabel(current: number, previous: number): { text: string; positive: boolean } | null {
  // Делить не на что, а «+∞%» ничего не объясняет.
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, positive: pct >= 0 };
}

/**
 * Главный финансовый дашборд владельца.
 *
 * Наверху — итоги ВЫБРАННОГО месяца одной строкой карточек, ниже те же четыре величины
 * по дням. Смена месяца меняет и то и другое разом: две части экрана всегда про один
 * период, и сравнивать их можно напрямую.
 *
 * Ledger, снимков, сторно и внутренних статусов здесь нет — для них свои экраны.
 *
 * Считается на чтении из существующих данных: ни своей таблицы, ни кнопки пересчёта
 * (обоснование и замеры — в modules/finance/ownerDashboard.ts).
 */
export default async function FinanceDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;

  const now = new Date();
  const year = Number(sp.year) || now.getUTCFullYear();
  const rawMonth = Number(sp.month);
  const month = Number.isInteger(rawMonth) && rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getUTCMonth() + 1;

  const from = utc(year, month - 1, 1);
  // Нулевой день следующего месяца — последний день текущего.
  const to = utc(year, month, 0);

  const [selected, previous, earliest] = await Promise.all([
    getOwnerMonth(from, to),
    // Предыдущий месяц нужен только ради процента у прибыли.
    getOwnerMonth(utc(year, month - 2, 1), utc(year, month - 1, 0)),
    prisma.order.findFirst({
      where: { orderStatus: "DELIVERED" },
      orderBy: { deliveryDate: "asc" },
      select: { deliveryDate: true },
    }),
  ]);

  const delta = deltaLabel(selected.ownerNetCents, previous.ownerNetCents);

  return (
    <div className="space-y-4">
      <PageHeader title="Финансы" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Выручка" value={formatCents(selected.revenueCents)} />
        <StatCard label="Расходы" value={formatCents(selected.expensesCents)} />
        <StatCard label="Флористы" value={formatCents(selected.floristEarningsCents)} />
        <StatCard
          label="Моя прибыль"
          tone={selected.ownerNetCents < 0 ? "danger" : "success"}
          value={
            <span className="flex flex-wrap items-baseline gap-2">
              {formatCents(selected.ownerNetCents)}
              {delta && (
                <span className={`text-xs font-normal ${delta.positive ? "text-emerald-600" : "text-red-600"}`}>
                  {delta.text}
                </span>
              )}
            </span>
          }
        />
      </div>

      {/* График и список — про один и тот же месяц и одни и те же числа: график берёт
          `selected.days`, из которых сложены карточки сверху. Второго источника нет.
          Расходов на нём намеренно нет: он про то, как заработок делится между мной и
          флористами, а не про то, из чего складывается выручка. */}
      {selected.days.length > 0 && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Прибыль по дням</CardTitle>
            <span className="text-xs text-slate-400">Моя прибыль и заработок флористов</span>
          </CardHeader>
          <CardBody>
            <OwnerMonthChart
              days={selected.days}
              from={from.toISOString().slice(0, 10)}
              to={to.toISOString().slice(0, 10)}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Итог</CardTitle>
          <ExpenseFilters years={yearOptions(earliest?.deliveryDate ?? null)} />
        </CardHeader>
        <CardBody className={selected.days.length === 0 ? undefined : "p-0"}>
          {selected.days.length === 0 ? (
            <EmptyState
              title="За этот месяц доставленных заказов нет"
              description="Дни появляются здесь, когда заказ переходит в «Доставлен»."
            />
          ) : (
            <OwnerDayList days={selected.days} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
