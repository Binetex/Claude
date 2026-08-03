import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listShareDaysRead, readShareDayBreakdown } from "@/modules/finance/shareRead";
import { RecomputeDayButton } from "./RecomputeDayButton";

export const dynamic = "force-dynamic";

/**
 * Разбор одного дня. Читает опубликованные снимки и книгу — не пересчитывает.
 *
 * Подробности намеренно вынесены с общего списка: грузить разбор всех дней ради экрана,
 * где смотрят один, — ровно то, из-за чего список открывался секундами.
 */
export default async function ShareDayPage({ params }: { params: Promise<{ day: string }> }) {
  await requireRole("OWNER");
  const { day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  // Профиль берём из того же читающего модуля — отдельного резолва здесь не заводим.
  const head = await listShareDaysRead({ page: 1, perPage: 20 });
  if (!head.profileId) notFound();

  const detail = await readShareDayBreakdown(head.profileId, new Date(`${day}T00:00:00.000Z`), true);
  if (!detail) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Расчёт доли · ${detail.day}`}
        description={head.floristName ?? undefined}
        actions={
          <div className="flex items-center gap-3">
            <Link href="/dashboard/finance/share" className="text-sm text-slate-500 hover:text-slate-800">
              К списку дней
            </Link>
            <RecomputeDayButton day={detail.day} />
          </div>
        }
      />

      {!detail.calculated ? (
        <Card>
          <CardBody>
            <EmptyState
              title="День ещё не рассчитан"
              description="Опубликованных снимков за этот день нет. Нажмите «Пересчитать день», чтобы собрать расчёт — просмотр сам по себе ничего не создаёт."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Распределяемая прибыль" value={formatCents(detail.distributableCents)} />
            <StatCard
              label={`Расчётная доля${detail.sharePercentBp != null ? ` · ${(detail.sharePercentBp / 100).toFixed(2)}%` : ""}`}
              value={formatCents(detail.shareCents)}
            />
            <StatCard
              label="Начислено"
              value={detail.accruedCents != null ? formatCents(detail.accruedCents) : "—"}
              tone={detail.stale ? "warning" : detail.accruedCents != null ? "success" : "default"}
            />
            <StatCard label="Заказов в расчёте" value={`${detail.orders.filter((o) => o.included).length} из ${detail.orders.length}`} />
          </div>

          {detail.stale && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Начисление ({formatCents(detail.accruedCents ?? 0)}) не совпадает с опубликованным расчётом (
              {formatCents(detail.shareCents)}). Состав дня изменился после начисления — например, заказ переназначили
              или добавили расход. Диспетчер выровняет сумму сам, кнопка «Пересчитать день» сделает это сразу.
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Формула дня</CardTitle>
            </CardHeader>
            <CardBody>
              <table className="w-full text-sm">
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.label} className="border-b border-slate-50">
                      <td className="py-1.5 text-slate-600">{l.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-700">
                        {l.negative ? "−" : ""}
                        {formatCents(l.cents)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200">
                    <td className="py-2 font-medium text-slate-800">Распределяемая прибыль</td>
                    <td className="py-2 text-right font-semibold tabular-nums">{formatCents(detail.distributableCents)}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-slate-600">
                      × {detail.sharePercentBp != null ? (detail.sharePercentBp / 100).toFixed(2) : "—"}%
                    </td>
                    <td className="py-1.5 text-right font-semibold tabular-nums text-emerald-700">
                      {formatCents(detail.shareCents)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
                Суммы взяты из опубликованных ревизий снимков этого дня — тех самых, которыми объясняется начисление.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Заказы дня · {detail.orders.length}</CardTitle>
            </CardHeader>
            <CardBody className="p-0 px-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                    <th className="py-2 pr-3 font-medium">Заказ</th>
                    <th className="py-2 pr-3 font-medium">Магазин</th>
                    <th className="py-2 pr-3 text-right font-medium">Цветочная часть</th>
                    <th className="py-2 pr-3 text-right font-medium">Доля закупки</th>
                    <th className="py-2 pr-3 text-right font-medium">Прибыль</th>
                    <th className="py-2 text-right font-medium">Ревизия</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.orders.map((o) => (
                    <tr key={o.orderId} className={`border-b border-slate-50 last:border-0 ${o.included ? "" : "text-slate-400"}`}>
                      <td className="py-2 pr-3">
                        <Link href={`/dashboard/finance/orders/${o.orderId}`} className="text-blue-600 hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-slate-500">{o.siteShortName}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCents(o.flowerRevenueCents)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCents(o.allocatedFlowerCents)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {o.included ? formatCents(o.distributableCents) : "не в расчёте"}
                      </td>
                      <td className="py-2 text-right tabular-nums text-slate-400">rev{o.revision}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
