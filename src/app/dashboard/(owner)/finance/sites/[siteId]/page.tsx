import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/cents";
import { getSiteDetail } from "@/modules/finance/sitesRevenue";
import { resolvePeriod } from "@/modules/finance/period";
import { FinancePeriodBar } from "@/components/finance/PeriodBar";
import { SiteDaysChart } from "./SiteDaysChart";

export const dynamic = "force-dynamic";

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/**
 * Один магазин за период: те же три числа и разбивка по дням.
 *
 * Своего списка заказов здесь нет намеренно. День ведёт в обычный раздел «Заказы» с уже
 * выставленными фильтрами по магазину и дате — там карточки, поиск, статусы и переходы,
 * которые пришлось бы повторять, а потом чинить в двух местах.
 */
export default async function FinanceSiteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const { siteId } = await params;
  const sp = await searchParams;
  const period = resolvePeriod(sp);

  const site = await getSiteDetail(siteId, period.from, period.to);
  if (!site) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={site.name}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/finance/sites">
              <ArrowLeft className="size-4" />
              Все магазины
            </Link>
          </Button>
        }
      />

      <FinancePeriodBar current={period.kind} />

      {/* На телефоне три колонки режут суммы — карточки идут в столбик. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Заказов" value={site.ordersTotal} />
        <StatCard label="Выручка" value={formatCents(site.revenueCents)} />
        <StatCard label="Средний чек" value={formatCents(site.avgCents)} />
      </div>

      {/* График динамики и список дней читают один и тот же site.days. */}
      {site.days.length > 1 && (
        <Card>
          <CardBody>
            <SiteDaysChart days={site.days} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>По дням</CardTitle>
          <span className="text-xs text-slate-400">{period.label}</span>
        </CardHeader>
        <CardBody className={site.days.length === 0 ? undefined : "p-0"}>
          {site.days.length === 0 ? (
            <EmptyState
              title="За этот период заказов нет"
              description="Заказы считаются по дате доставки. Отменённые и ожидающие оплаты не в счёт."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {site.days.map((d) => {
                const date = new Date(`${d.day}T00:00:00.000Z`);
                return (
                  <li key={d.day}>
                    <Link
                      href={`/dashboard/orders?siteId=${site.siteId}&from=${d.day}&to=${d.day}`}
                      className="flex items-center gap-4 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-emerald-500 hover:bg-slate-50/60"
                    >
                      <div className="w-9 shrink-0 text-center">
                        <div className="text-lg leading-none font-semibold text-slate-900">
                          {date.getUTCDate()}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          {MONTHS_SHORT[date.getUTCMonth()]}
                        </div>
                      </div>
                      <div className="grid flex-1 grid-cols-2 gap-x-4 sm:gap-x-6">
                        <div className="min-w-0">
                          <div className="truncate text-xs text-slate-400">Заказов</div>
                          <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
                            {d.ordersTotal}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-xs text-slate-400">Выручка</div>
                          <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">
                            {formatCents(d.revenueCents)}
                          </div>
                        </div>
                      </div>
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-slate-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
