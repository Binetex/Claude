import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { FloristAvatar } from "@/components/FloristAvatar";
import { FinancePeriodBar } from "@/components/finance/PeriodBar";
import { OrdersNavProvider, OrdersPendingArea } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { formatDollars } from "@/lib/cents";
import { floristBalances } from "@/modules/finance/balance";
import { listCurrentProfiles } from "@/modules/finance/profile";
import { countDeliveredByFlorist } from "@/modules/finance/review";
import { accrualGate } from "@/modules/finance/config";
import { resolvePeriod } from "@/modules/finance/period";
import { getFloristsEarnings } from "@/modules/finance/floristsEarnings";
import { FloristsChart } from "./FloristsChart";

export const dynamic = "force-dynamic";

const modelMeta = {
  PRIMARY: { label: "Основной", className: "bg-violet-50 text-violet-700 border-violet-200" },
  SECONDARY: { label: "Второстепенный", className: "bg-sky-50 text-sky-700 border-sky-200" },
} as const;

const th = "px-3 py-2.5 text-right font-medium";

/**
 * «Флористы» — обзор заработка всех сразу и вход в каждого по отдельности.
 *
 * ЗДЕСЬ НЕ LEDGER. Начислено/выплачено/удержано — это разбор расчётов с конкретным
 * человеком, и живёт он внутри флориста. Наверху только то, ради чего на страницу заходят:
 * сколько заработали, за сколько заказов и как это распределилось по дням.
 *
 * Колонки таблицы делятся на две группы, и путать их нельзя: «за период» отвечают на выбор
 * дат сверху, «за всё время» — нет. Долг периодом не измеряется: он складывается из всей
 * истории заработка и выплат, и «К выплате за неделю» было бы числом ни о чём.
 */
export default async function FinanceFloristsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;
  const period = resolvePeriod(sp);

  const florists = await prisma.florist.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const ids = florists.map((f) => f.id);

  const [balances, profiles, delivered, earnings] = await Promise.all([
    floristBalances(ids),
    listCurrentProfiles(),
    countDeliveredByFlorist(ids),
    getFloristsEarnings(period.from, period.to),
  ]);

  const gate = accrualGate();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — флористы"
        description="Заработок считается из данных, выплаты — из книги операций. Отдельного хранимого «сколько должны» не существует."
      />

      {/* Провайдер связывает панель периода с приглушением содержимого — см. страницу
          «Магазины»: без видимого ожидания смена дат выглядит как зависание. */}
      <OrdersNavProvider>
        <FinancePeriodBar current={period.kind} />
        <OrdersPendingArea>
          <div className="mt-4 space-y-4">

          {!gate.enabled && (
            <Card>
              <CardBody className="text-sm text-slate-600">
                <div className="font-medium text-slate-800">Начисления выключены</div>
                <div className="mt-1 text-slate-500">
                  Причина: {gate.reason}. Пока гейт закрыт, новые начисления не создаются — ни автоматически,
                  ни при доставке заказа. Уже созданные записи продолжают отображаться.
                </div>
              </CardBody>
            </Card>
          )}

          {/* На телефоне три колонки режут суммы — карточки идут в столбик. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Заработали флористы" value={formatDollars(earnings.earnedCents)} />
            <StatCard label="Выполнено заказов" value={earnings.ordersTotal} />
            <StatCard label="Средний заработок на заказ" value={formatDollars(earnings.avgCents)} />
          </div>

          {/* Молчать об этом нельзя: и то и другое занижает все три числа выше, а причина не
              видна. Ссылка ведёт туда, где это чинится. */}
          {(earnings.pending.days > 0 || earnings.pending.orders > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              В расчёт не вошло:{" "}
              {[
                earnings.pending.days > 0 && `${earnings.pending.days} дн. без полных данных`,
                earnings.pending.orders > 0 && `${earnings.pending.orders} заказ(ов) без цены флориста`,
              ]
                .filter(Boolean)
                .join(", ")}
              .{" "}
              <Link href="/dashboard/finance/setup" className="font-medium underline">
                Требует заполнения
              </Link>
            </div>
          )}

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Заработок по дням</CardTitle>
              <span className="text-xs text-slate-400">{period.label}</span>
            </CardHeader>
            <CardBody>
              {earnings.series.length === 0 ? (
                <EmptyState
                  title="За этот период заработка нет"
                  description="Заработок появляется по дате доставки заказа: у основного флориста — за посчитанные дни, у второстепенного — за доставленные заказы с заданной ценой."
                />
              ) : earnings.points.length < 2 ? (
                // График динамики на одном дне — две точки в пустоте: динамики в одном дне нет.
                // Всё, что он мог бы сказать, уже стоит в карточках сверху и в таблице ниже.
                <EmptyState
                  title="Выбран один день"
                  description="Динамика показывается от двух дней. Кто сколько заработал в этот день — в таблице ниже."
                />
              ) : (
                <FloristsChart points={earnings.points} series={earnings.series} />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Флористы</CardTitle>
              <span className="text-xs text-slate-400">
                Первые две суммы — за {period.label.toLowerCase()}, остальные — за всё время
              </span>
            </CardHeader>
            <CardBody className="p-0">
              {florists.length === 0 ? (
                <EmptyState title="Флористов нет" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                        <th className="px-4 py-2.5 font-medium">Флорист</th>
                        <th className="px-3 py-2.5 font-medium">Модель</th>
                        <th className={th}>Заработал</th>
                        <th className={`${th} border-r border-slate-100`}>Заказов</th>
                        <th className={th}>Доставлено</th>
                        <th className={th}>Начислено</th>
                        <th className={th}>Выплачено</th>
                        <th className="px-4 py-2.5 text-right font-medium">К выплате</th>
                      </tr>
                    </thead>
                    <tbody>
                      {florists.map((f) => {
                        const b = balances.get(f.id)!;
                        const profile = profiles.get(f.id);
                        const inPeriod = earnings.byFlorist.get(f.id);
                        return (
                          <tr key={f.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                            <td className="px-4 py-3">
                              <Link href={`/dashboard/finance/florists/${f.id}`} className="flex items-center gap-2">
                                <FloristAvatar name={f.user.name} avatarUrl={f.avatarUrl} size={24} />
                                <span className="font-medium text-slate-800 hover:underline">{f.user.name}</span>
                                {!f.active && <span className="text-xs text-slate-400">отключён</span>}
                              </Link>
                            </td>
                            <td className="px-3 py-3">
                              {profile ? (
                                <Badge className={modelMeta[profile.model].className}>{modelMeta[profile.model].label}</Badge>
                              ) : (
                                // Отсутствие профиля — не «по умолчанию второстепенный».
                                // Пока модель не задана, начисление не создаётся вовсе.
                                <Badge className="border-amber-200 bg-amber-50 text-amber-800">не задана</Badge>
                              )}
                            </td>
                            <td className="px-3 py-3 text-right font-medium tabular-nums text-slate-800">
                              {formatDollars(inPeriod?.earnedCents ?? 0)}
                            </td>
                            <td className="border-r border-slate-100 px-3 py-3 text-right tabular-nums text-slate-600">
                              {inPeriod?.orders ?? 0}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-600">{delivered.get(f.id) ?? 0}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatDollars(b.earnedCents)}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatDollars(b.paidCents)}</td>
                            <td
                              className={`px-4 py-3 text-right font-semibold tabular-nums ${
                                b.outstandingCents < 0 ? "text-red-600" : "text-emerald-700"
                              }`}
                            >
                              {formatDollars(b.outstandingCents)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
          </div>
        </OrdersPendingArea>
      </OrdersNavProvider>
    </div>
  );
}
