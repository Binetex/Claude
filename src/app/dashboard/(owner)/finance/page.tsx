import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import { OwnerDayList } from "@/components/finance/OwnerDayList";
import { getOwnerMonth } from "@/modules/finance/ownerDashboard";
import { yearOptions } from "@/modules/finance/expensePeriod";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** «−12%» рядом с месяцем: как он идёт против предыдущего. */
function deltaLabel(current: number, previous: number): { text: string; positive: boolean } | null {
  // Делить не на что, а «+∞%» ничего не объясняет.
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, positive: pct >= 0 };
}

/**
 * Главный финансовый дашборд владельца.
 *
 * Отвечает на один вопрос: сколько бизнес заработал, сколько отдал и сколько осталось.
 * Ledger, снимков, сторно, корректировок и внутренних статусов здесь нет — для них свои
 * экраны.
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

  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const curMonthStart = utc(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const curMonthEnd = utc(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
  const prevMonthStart = utc(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const prevMonthEnd = utc(now.getUTCFullYear(), now.getUTCMonth(), 0);

  const [selected, todayOnly, curMonth, prevMonth, allTime, earliest] = await Promise.all([
    getOwnerMonth(from, to),
    getOwnerMonth(today, today),
    getOwnerMonth(curMonthStart, curMonthEnd),
    getOwnerMonth(prevMonthStart, prevMonthEnd),
    // «За всё время» — от заведомо ранней даты до сегодня.
    getOwnerMonth(utc(2000, 0, 1), today),
    prisma.order.findFirst({
      where: { orderStatus: "DELIVERED" },
      orderBy: { deliveryDate: "asc" },
      select: { deliveryDate: true },
    }),
  ]);

  const delta = deltaLabel(curMonth.ownerNetCents, prevMonth.ownerNetCents);

  return (
    <div className="space-y-4">
      <PageHeader title="Финансы" description="Сколько бизнес заработал, отдал и сколько осталось." />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Прибыль сегодня" value={formatCents(todayOnly.ownerNetCents)} />
        <StatCard
          label="Прибыль за месяц"
          value={
            <span className="flex flex-wrap items-baseline gap-2">
              {formatCents(curMonth.ownerNetCents)}
              {delta && (
                <span className={`text-sm font-normal ${delta.positive ? "text-emerald-600" : "text-red-600"}`}>
                  {delta.text}
                </span>
              )}
            </span>
          }
        />
        <StatCard label="Прибыль за всё время" value={formatCents(allTime.ownerNetCents)} />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>
            {MONTHS[month - 1]} {year} · чистыми {formatCents(selected.ownerNetCents)}
          </CardTitle>
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

        {selected.days.length > 0 && (
          <div className="border-t border-slate-200 bg-slate-50/60 px-4 py-3">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-4">
              <Total label="Доход бизнеса" cents={selected.revenueCents} />
              <Total label="Доход флористов" cents={selected.floristEarningsCents} />
              <Total label="Мои расходы" cents={selected.ownerExpensesCents} />
              <Total label="Мой чистый доход" cents={selected.ownerNetCents} strong />
            </div>
            {selected.incompleteDays > 0 && (
              <p className="mt-2 text-xs text-amber-700">
                Дней не готово к расчёту: {selected.incompleteDays}. В итог они не входят — заполните недостающее
                в разделе «Требует заполнения».
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Total({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className={`tabular-nums sm:mt-0.5 sm:block ${
          strong ? "text-lg font-semibold text-slate-900" : "text-sm text-slate-700"
        }`}
      >
        {formatCents(cents)}
      </span>
    </div>
  );
}
