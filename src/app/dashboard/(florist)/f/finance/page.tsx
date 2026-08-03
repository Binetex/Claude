import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireFlorist } from "@/lib/rbac";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { cn } from "@/lib/cn";
import { floristBalance } from "@/modules/finance/balance";
import { floristEarningTotals, floristEarningsRange, floristDayOrders, resolvePeriod } from "@/modules/finance/earnings";
import { formatDayLong, pluralOrders } from "@/modules/finance/earningsFormat";
import { resolveProfileAt } from "@/modules/finance/profile";
import { EarningsPeriodBar } from "./EarningsPeriodBar";

export const dynamic = "force-dynamic";

/**
 * Заработок флориста: сколько я заработал и из каких заказов. Один экран — один вопрос.
 *
 * В маршруте СОЗНАТЕЛЬНО нет сегмента [floristId]: id берётся из сессии через requireFlorist,
 * подставить чужой физически некуда.
 *
 * Здесь нет ни баланса по строкам, ни начислений, ни удержаний: деньги показываются днями и
 * заказами. «К выплате» приходит из balance.ts — единственного источника долга; второй способ
 * посчитать остаток уже приводил к тому, что два экрана показывали разные числа.
 */

/** Крупная карточка суммы. Первая — акцентная: это ответ на главный вопрос экрана. */
function MoneyCard({
  label,
  cents,
  hint,
  accent = false,
}: {
  label: string;
  cents: number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        accent ? "border-slate-800 bg-slate-800" : "border-slate-200 bg-white shadow-xs"
      )}
    >
      <div className={cn("text-[11px] font-medium tracking-wide uppercase", accent ? "text-slate-300" : "text-slate-400")}>
        {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-bold tabular-nums sm:text-3xl", accent ? "text-white" : "text-slate-900")}>
        {formatCents(cents)}
      </div>
      {/* Неразрывный пробел держит высоту карточек одинаковой, когда подписи нет. */}
      <div className={cn("mt-0.5 text-xs", accent ? "text-slate-400" : "text-slate-400")}>{hint ?? " "}</div>
    </div>
  );
}

export default async function FloristEarningsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;
  const period = resolvePeriod(sp.period, { from: sp.from, to: sp.to });

  const [balance, totals, range, profile] = await Promise.all([
    floristBalance(user.floristId),
    floristEarningTotals(user.floristId),
    floristEarningsRange(user.floristId, period.from, period.to),
    resolveProfileAt(user.floristId, new Date()),
  ]);

  // Однодневный период показываем заказами сразу: ради одной строки не стоит заставлять
  // человека проваливаться ещё на страницу вниз. У основного флориста заказы дня в его
  // заработок не складываются (доля считается от прибыли дня целиком) — там всегда дни.
  const isSecondary = profile?.model === "SECONDARY";
  const dayOrders = period.singleDay && isSecondary ? await floristDayOrders(user.floristId, period.from) : null;

  const todayHint =
    profile?.model === "PRIMARY" && totals.today.cents === 0 ? "день ещё считается" : pluralOrders(totals.today.orders);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Отрицательное «к выплате» — это переплата, а не ошибка. Без подписи такое число
            выглядит поломкой, поэтому объясняем его прямо на карточке. */}
        <MoneyCard
          label="К выплате"
          cents={balance.outstandingCents}
          hint={balance.outstandingCents < 0 ? "выплачено больше, чем заработано" : undefined}
          accent
        />
        <MoneyCard label="Заработок за сегодня" cents={totals.today.cents} hint={todayHint} />
        <MoneyCard label="Заработок за месяц" cents={totals.month.cents} hint={pluralOrders(totals.month.orders)} />
        <MoneyCard label="Заработок за всё время" cents={totals.allTime.cents} hint={pluralOrders(totals.allTime.orders)} />
      </div>

      <EarningsPeriodBar activeKey={period.key} />

      <Card>
        <CardBody className="p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="text-sm font-semibold text-slate-800">{period.label}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold tabular-nums text-slate-900">{formatCents(range.cents)}</span>
              <span className="text-xs text-slate-400">{pluralOrders(range.orders)}</span>
            </div>
          </div>

          {range.orders === 0 ? (
            <EmptyState title="За этот период заказов нет" description="Выберите другой период." />
          ) : dayOrders ? (
            <ul>
              {dayOrders.orders.map((o) => (
                <li key={o.orderId}>
                  <Link
                    href={`/dashboard/f/${o.orderId}`}
                    className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-0 hover:bg-slate-50"
                  >
                    <span className="font-medium text-slate-800">#{o.orderNumber}</span>
                    <span className="flex items-center gap-2">
                      {o.adjusted && <span className="text-[11px] text-amber-600">учтён расход</span>}
                      <span className="tabular-nums text-slate-900">{formatCents(o.cents)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              {range.days.map((d) => (
                <li key={d.day}>
                  <Link
                    href={`/dashboard/f/finance/day/${d.day}`}
                    className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-0 hover:bg-slate-50"
                  >
                    <span className="font-medium text-slate-800">{formatDayLong(d.day)}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-slate-400">{pluralOrders(d.orders)}</span>
                      <span className="tabular-nums font-semibold text-slate-900">{formatCents(d.cents)}</span>
                      <ChevronRight size={16} className="text-slate-300" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Link href="/dashboard/f/finance/payouts" className="inline-flex text-sm text-slate-500 hover:text-slate-900">
        История выплат →
      </Link>
    </div>
  );
}
