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

const blockerLabels: Record<string, string> = {
  DAILY_FLOWER_EXPENSE_MISSING: "не внесена дневная закупка цветов",
  ORDER_DATA_INCOMPLETE: "заполнены не все заказы",
};

const missingLabels: Record<string, string> = {
  DELIVERY_ACTUAL_COST: "фактическая доставка",
  ACQUIRING_FEE: "комиссия эквайринга",
  VASE_GIFT_COST: "закупка вазы или подарка",
  CONSUMABLES_RATE: "ставка расходников",
};

/**
 * Разбор одного дня. Читает строку итога дня — не считает и не пишет.
 *
 * Долг флориста выводится из этих же строк, поэтому «начислено» отдельной величиной здесь
 * больше нет: доля дня и есть то, что вошло в долг.
 */
export default async function ShareDayPage({ params }: { params: Promise<{ day: string }> }) {
  await requireRole("OWNER");
  const { day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  const head = await listShareDaysRead({ page: 1, perPage: 20 });
  if (!head.profileId) notFound();

  const detail = await readShareDayBreakdown(head.profileId, new Date(`${day}T00:00:00.000Z`));
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
              description="Нажмите «Пересчитать день», чтобы собрать расчёт. Просмотр сам по себе ничего не создаёт."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard label="Распределяемая прибыль" value={formatCents(detail.distributableCents)} />
            <StatCard
              label={`Доля флориста${detail.sharePercentBp != null ? ` · ${(detail.sharePercentBp / 100).toFixed(2)}%` : ""}`}
              value={formatCents(detail.shareCents)}
              tone={detail.complete ? "success" : "default"}
            />
            <StatCard label="Заказов в дне" value={detail.orders.length} />
          </div>

          {!detail.complete && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              День не считается: {detail.blockers.map((b) => blockerLabels[b] ?? b).join(", ")}. Доля появится, когда
              день будет заполнен целиком — до тех пор он в долг не входит.
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
                Дневная закупка цветов вычитается один раз на весь день — она и есть расход дня.
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
                    <th className="py-2 pr-3 text-right font-medium">Вклад в прибыль дня</th>
                    <th className="py-2 font-medium">Чего не хватает</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.orders.map((o) => (
                    <tr key={o.orderId} className={`border-b border-slate-50 last:border-0 ${o.missing.length ? "text-slate-400" : ""}`}>
                      <td className="py-2 pr-3">
                        <Link href={`/dashboard/orders/${o.orderId}`} className="text-blue-600 hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {o.missing.length ? "—" : formatCents(o.contributionCents)}
                      </td>
                      <td className="py-2 text-amber-700">
                        {o.missing.map((m) => missingLabels[m] ?? m).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="py-2.5 text-xs text-slate-400">
                Вклад заказа — его выручка за вычетом собственных расходов, до дневной закупки цветов.
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
