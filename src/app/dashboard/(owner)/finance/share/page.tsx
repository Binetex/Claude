import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listShareDays, getShareDayBreakdown } from "@/modules/finance/shareView";
import { SharePercentForm, RecomputeShareButton } from "./ShareControls";

export const dynamic = "force-dynamic";

export default async function PrimarySharePage() {
  await requireRole("OWNER");
  const { startDate, disabledReason, sharePercentBp, floristName, rows } = await listShareDays();

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true },
  });

  const accruedTotal = rows.reduce((a, r) => a + (r.accruedCents ?? 0), 0);
  const pendingDays = rows.filter((r) => !r.blocked && r.accruedCents == null && r.shareCents > 0).length;
  const blockedDays = rows.filter((r) => r.blocked).length;

  // Разбор считаем только для дней, которые уже начислены либо готовы — по
  // заблокированным показывать нечего, кроме причины.
  const breakdowns = new Map(
    await Promise.all(
      rows
        .filter((r) => !r.blocked)
        .slice(0, 10)
        .map(async (r) => {
          const b = profile ? await getShareDayBreakdown(profile.id, new Date(`${r.day}T00:00:00.000Z`), true) : null;
          return [r.day, b] as const;
        })
    )
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Доля основного флориста${floristName ? ` · ${floristName}` : ""}`}
        description="Ежедневный расчёт. Начисление показывает рассчитанный долг и денег не переводит — реальная выплата появляется только вручную операцией «Выплата»."
        actions={
          <div className="flex items-center gap-3">
            {profile && sharePercentBp != null && <RecomputeShareButton />}
          </div>
        }
      />

      {disabledReason ? (
        <Card>
          <CardBody className="text-sm text-slate-600">
            <div className="font-medium text-slate-800">Расчёт не запущен</div>
            <div className="mt-1 text-slate-500">{disabledReason}</div>
          </CardBody>
        </Card>
      ) : sharePercentBp == null ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <div className="font-medium text-slate-800">Доля не задана</div>
              <div className="mt-1 text-sm text-slate-500">
                Пока процент не задан, начисления не создаются: подставлять значение «по умолчанию» нельзя — это деньги.
              </div>
            </div>
            {profile && <SharePercentForm floristId={profile.floristId} defaultDate={startDate} />}
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Доля" value={`${(sharePercentBp / 100).toFixed(2)}%`} />
            <StatCard label="Начислено всего" value={formatCents(accruedTotal)} tone="success" />
            <StatCard label="Дней ждут начисления" value={pendingDays} tone={pendingDays > 0 ? "info" : "default"} />
            <StatCard label="Дней заблокировано" value={blockedDays} tone={blockedDays > 0 ? "warning" : "default"} />
          </div>

          {startDate && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>Считаются заказы с {startDate.toISOString().slice(0, 10)}. Более ранние — исторические.</span>
              {profile && <SharePercentForm floristId={profile.floristId} defaultDate={startDate} compact />}
            </div>
          )}
        </>
      )}

      {rows.length === 0 ? (
        !disabledReason && (
          <Card>
            <CardBody>
              <EmptyState title="Доставленных заказов с даты запуска пока нет" />
            </CardBody>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const b = breakdowns.get(r.day);
            return (
              <Card key={r.day}>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>
                    {r.day}{" "}
                    {r.blocked ? (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-800">заблокирован</Badge>
                    ) : r.accruedCents != null ? (
                      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">начислено</Badge>
                    ) : (
                      <Badge className="border-slate-200 bg-slate-50 text-slate-600">готов к начислению</Badge>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-slate-400">
                      заказов {r.ordersCalculable} из {r.ordersTotal}
                    </span>
                    <span className="tabular-nums text-slate-600">
                      прибыль {formatCents(r.distributableCents)}
                    </span>
                    <span className="font-semibold tabular-nums text-emerald-700">
                      доля {formatCents(r.accruedCents ?? r.shareCents)}
                    </span>
                  </div>
                </CardHeader>
                <CardBody>
                  {r.blocked ? (
                    <div className="text-sm text-amber-800">
                      День не считается: {r.blockers.join(", ")}.{" "}
                      <Link href="/dashboard/finance/setup" className="text-blue-600 hover:underline">
                        Заполнить
                      </Link>
                    </div>
                  ) : b ? (
                    <details>
                      <summary className="cursor-pointer text-sm text-slate-500">Полная формула</summary>
                      <table className="mt-2 w-full text-sm">
                        <tbody>
                          {b.lines.map((l) => (
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
                            <td className="py-2 text-right font-semibold tabular-nums">
                              {formatCents(b.distributableCents)}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-1.5 text-slate-600">
                              × {b.sharePercentBp != null ? (b.sharePercentBp / 100).toFixed(2) : "—"}%
                            </td>
                            <td className="py-1.5 text-right font-semibold tabular-nums text-emerald-700">
                              {formatCents(b.shareCents)}
                            </td>
                          </tr>
                        </tbody>
                      </table>

                      <div className="mt-3 text-xs text-slate-400">Заказы дня</div>
                      <table className="mt-1 w-full text-xs">
                        <tbody>
                          {b.orders.map((o) => (
                            <tr key={o.orderId} className={o.included ? "" : "text-slate-400"}>
                              <td className="py-0.5 pr-2">
                                <Link href={`/dashboard/finance/orders/${o.orderId}`} className="text-blue-600 hover:underline">
                                  {o.orderNumber}
                                </Link>
                              </td>
                              <td className="py-0.5 pr-2 text-slate-400">{o.siteShortName}</td>
                              <td className="py-0.5 pr-2 text-right tabular-nums">цветы {formatCents(o.flowerRevenueCents)}</td>
                              <td className="py-0.5 pr-2 text-right tabular-nums">закупка {formatCents(o.allocatedFlowerCents)}</td>
                              <td className="py-0.5 text-right tabular-nums">
                                {o.included ? formatCents(o.distributableCents) : "не в расчёте"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ) : (
                    <div className="text-sm text-slate-400">Разбор доступен для десяти последних дней.</div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
