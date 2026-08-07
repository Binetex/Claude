import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatDollars } from "@/lib/cents";
import { getSitesRevenue } from "@/modules/finance/sitesRevenue";
import { resolvePeriod } from "@/modules/finance/period";
import { FinancePeriodBar } from "@/components/finance/PeriodBar";
import { SitesChart } from "./SitesChart";

export const dynamic = "force-dynamic";

/**
 * «Магазины» — сколько заказов и выручки приносит каждый.
 *
 * ПРО ПРИБЫЛЬ ЗДЕСЬ НИЧЕГО НЕТ, и это не упущение. Главный расход дня — общая закупка
 * цветов — к магазину не привязан, а доля основного флориста считается от прибыли дня
 * целиком, сразу по всем магазинам. Честно разложить их по магазинам нечем, а выдуманное
 * правило дележа дало бы четыре красивых числа, ни одному из которых нельзя верить.
 * Прибыль живёт на «Обзоре», где она считается по-настоящему.
 */
export default async function FinanceSitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const data = await getSitesRevenue(period.from, period.to);

  // Период переносится в ссылку магазина: иначе клик по строке за «вчера» открывал бы месяц.
  const q = new URLSearchParams(
    Object.entries({ period: sp.period, from: sp.from, to: sp.to }).filter(
      (e): e is [string, string] => !!e[1]
    )
  ).toString();

  return (
    <div className="space-y-4">
      <PageHeader title="Магазины" />

      <FinancePeriodBar current={period.kind} />

      {/* На телефоне три колонки режут суммы — карточки идут в столбик. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Заказов" value={data.ordersTotal} />
        <StatCard label="Выручка" value={formatDollars(data.revenueCents)} />
        <StatCard label="Средний чек" value={formatDollars(data.avgCents)} />
      </div>

      {/* График — как шли дни и из чего складывался каждый; таблица под ним — итоги за
          весь период. Оба из одного серверного результата. */}
      {data.rows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Выручка по дням</CardTitle>
            <span className="text-xs text-slate-400">{period.label}</span>
          </CardHeader>
          <CardBody>
            <SitesChart points={data.points} series={data.series} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Выручка по магазинам</CardTitle>
          <span className="text-xs text-slate-400">{period.label}</span>
        </CardHeader>
        <CardBody className={data.rows.length === 0 ? undefined : "p-0"}>
          {data.rows.length === 0 ? (
            <EmptyState
              title="За этот период заказов нет"
              description="Заказы считаются по дате доставки. Отменённые и ожидающие оплаты не в счёт."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <li key={r.siteId}>
                  <Link
                    href={`/dashboard/finance/sites/${r.siteId}${q ? `?${q}` : ""}`}
                    // Прозрачная рамка слева заранее: на hover она красится, и строка не
                    // дёргается от появления границы.
                    className="flex items-center gap-3 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-emerald-500 hover:bg-slate-100/70 sm:gap-4"
                  >
                    {/* На узком экране — короткий код магазина в фиксированной колонке:
                        полное имя забирало половину строки, и все суммы обрезались до «$3…».
                        Код у магазина свой (Site.shortName), а не произвольные три буквы. */}
                    <div className="w-16 shrink-0 truncate text-xs font-semibold text-slate-900 sm:w-auto sm:min-w-0 sm:flex-1 sm:text-sm">
                      <span className="sm:hidden">{r.shortName}</span>
                      <span className="hidden sm:inline">{r.name}</span>
                    </div>
                    <div className="grid flex-1 grid-cols-3 gap-x-2 text-right sm:gap-x-6">
                      <Metric label="Заказов" value={String(r.ordersTotal)} />
                      <Metric label="Выручка" value={formatDollars(r.revenueCents)} />
                      <Metric label="Средний чек" shortLabel="Ср. чек" value={formatDollars(r.avgCents)} />
                    </div>
                    {/* Стрелка только на большом экране: на телефоне она отбирала у цифр
                        последние 30px, а что по строке можно нажать — и так понятно. */}
                    <ChevronRight aria-hidden className="hidden size-4 shrink-0 text-slate-300 sm:block" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-400">
        Только выручка. Прибыль по магазинам не считается: общая закупка цветов и доля
        основного флориста относятся ко дню целиком, а не к магазину.
      </p>
    </div>
  );
}

/** `shortLabel` — для узкого экрана, где полная подпись обрезается многоточием. */
function Metric({ label, shortLabel, value }: { label: string; shortLabel?: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-slate-400">
        {shortLabel ? (
          <>
            <span className="sm:hidden">{shortLabel}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
