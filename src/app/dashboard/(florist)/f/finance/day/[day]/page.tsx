import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFlorist } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { readShareDayBreakdown, primaryProfileForFlorist } from "@/modules/finance/shareRead";
import { floristDayOrders, dayFromKey, isDayKey } from "@/modules/finance/earnings";
import { formatDayLong } from "@/modules/finance/earningsFormat";

export const dynamic = "force-dynamic";

/**
 * Финансы одного дня. Маршрут один, содержимое разное — потому что заработок у моделей
 * складывается по-разному, и показывать второстепенному флористу прибыль магазина незачем:
 *
 *  - ВТОРОСТЕПЕННЫЙ видит свои заказы дня и итог. Ни комиссий, ни налогов, ни чаевых,
 *    ни себестоимости — его деньги от них не зависят.
 *  - ОСНОВНОЙ видит разбор: доходы и расходы дня (включая расходы владельца),
 *    распределяемую прибыль и свою долю. Это и есть ответ «как посчиталась моя доля».
 *
 * В маршруте нет floristId: профиль берётся из сессии, чужой день посмотреть нельзя.
 */
export default async function FloristFinanceDayPage({ params }: { params: Promise<{ day: string }> }) {
  const user = await requireFlorist();
  const { day } = await params;
  if (!isDayKey(day)) notFound();

  const backLink = (
    <Link href="/dashboard/f/finance" className="text-sm text-slate-500 hover:text-slate-800">
      ← К заработку
    </Link>
  );

  const profile = await primaryProfileForFlorist(user.floristId);

  // ── Второстепенный: заказы дня и итог ──
  if (!profile) {
    const { orders, totalCents } = await floristDayOrders(user.floristId, dayFromKey(day));
    return (
      <div className="space-y-4">
        <PageHeader title={`Финансы за ${formatDayLong(day)}`} actions={backLink} />
        <Card>
          <CardBody className="p-0">
            {orders.length === 0 ? (
              <EmptyState title="В этот день заказов не было" />
            ) : (
              <>
                <ul>
                  {orders.map((o) => (
                    <li key={o.orderId}>
                      <Link
                        href={`/dashboard/f/${o.orderId}`}
                        className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 hover:bg-slate-50"
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
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="font-semibold text-slate-800">Итого</span>
                  <span className="text-lg font-bold tabular-nums text-emerald-700">{formatCents(totalCents)}</span>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  // ── Основной: разбор дня со всеми расходами ──
  const breakdown = await readShareDayBreakdown(profile.id, dayFromKey(day));
  if (!breakdown) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Финансы за ${formatDayLong(day)}`}
        description="Как получилась сумма за этот день."
        actions={backLink}
      />

      {!breakdown.calculated ? (
        <Card>
          <CardBody className="text-sm text-slate-500">
            Расчёт за этот день ещё не сделан. Он появится, когда владелец внесёт данные дня.
          </CardBody>
        </Card>
      ) : (
        <>
          {!breakdown.complete && (
            <Card>
              <CardBody className="text-sm text-amber-800">
                День ещё не посчитан целиком — по части заказов не хватает данных. Пока это так, день в вашу сумму не
                входит.
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody>
              <table className="w-full text-sm">
                <tbody>
                  {breakdown.lines.map((l) => (
                    <tr key={l.label} className="border-b border-slate-50">
                      <td className="py-2 text-slate-600">{l.label}</td>
                      <td className="py-2 text-right tabular-nums text-slate-700">
                        {l.negative ? "−" : ""}
                        {formatCents(l.cents)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200">
                    <td className="py-2 font-medium text-slate-800">Распределяемая прибыль</td>
                    <td className="py-2 text-right font-semibold tabular-nums">
                      {formatCents(breakdown.distributableCents)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600">
                      Ваша доля — {breakdown.sharePercentBp != null ? (breakdown.sharePercentBp / 100).toFixed(2) : "—"}%
                    </td>
                    <td className="py-2 text-right text-lg font-bold tabular-nums text-emerald-700">
                      {formatCents(breakdown.shareCents)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Налог, собранный с покупателей, вычитается полностью — его владелец перечисляет государству. Чаевые
                показаны в выручке и тут же вычтены: они целиком принадлежат владельцу.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Заказы этого дня · {breakdown.orders.length}</CardTitle>
            </CardHeader>
            <CardBody className="p-0 px-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                    <th className="py-2 pr-3 font-medium">Заказ</th>
                    <th className="py-2 text-right font-medium">Вклад в прибыль дня</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.orders.map((o) => (
                    <tr
                      key={o.orderId}
                      className={`border-b border-slate-50 last:border-0 ${o.missing.length ? "text-slate-400" : ""}`}
                    >
                      <td className="py-2 pr-3">
                        <Link href={`/dashboard/f/${o.orderId}`} className="text-blue-600 hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {o.missing.length ? "ещё не посчитан" : formatCents(o.contributionCents)}
                      </td>
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
