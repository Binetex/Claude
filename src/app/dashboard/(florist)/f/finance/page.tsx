import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireFlorist } from "@/lib/rbac";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { cn } from "@/lib/cn";
import { floristBalance } from "@/modules/finance/balance";
import { floristEarningTotals, floristEarningsRange, floristDayOrders, resolvePeriod, keyFromDay } from "@/modules/finance/earnings";
import { formatDayLong, pluralOrders } from "@/modules/finance/earningsFormat";
import { resolveProfileAt } from "@/modules/finance/profile";

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

const PERIODS = [
  { key: "today", label: "Сегодня" },
  { key: "yesterday", label: "Вчера" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
] as const;

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

  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ period: sp.period, from: sp.from, to: sp.to, ...patch })) {
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return `/dashboard/f/finance${s ? `?${s}` : ""}`;
  };

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

      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODS.map((p) => {
          const active = period.key === p.key;
          return (
            <Link
              key={p.key}
              href={href({ period: p.key, from: undefined, to: undefined })}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
              )}
            >
              {p.label}
            </Link>
          );
        })}

        {/* Произвольный диапазон — обычная GET-форма: состояние живёт в URL, клиентский код не нужен. */}
        <details className="relative">
          <summary
            className={cn(
              "cursor-pointer list-none rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              period.key === "custom"
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
            )}
          >
            Выбрать даты
          </summary>
          <form
            method="get"
            className="absolute z-10 mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg"
          >
            <input type="hidden" name="period" value="custom" />
            <label className="text-xs text-slate-500">
              С
              <input
                type="date"
                name="from"
                defaultValue={sp.from ?? keyFromDay(period.from)}
                className="mt-0.5 block rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              По
              <input
                type="date"
                name="to"
                defaultValue={sp.to ?? keyFromDay(period.to)}
                className="mt-0.5 block rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
              Показать
            </button>
          </form>
        </details>
      </div>

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
