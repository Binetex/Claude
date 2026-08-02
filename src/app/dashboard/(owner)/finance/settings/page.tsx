import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { dayKey } from "@/modules/finance/snapshot";
import { ConsumablesForm, FeeModelForm, FlowerExpenseForm, TaxPolicyForm } from "./SettingsForms";

export const dynamic = "force-dynamic";

const period = (from: Date, to: Date | null) => `${dayKey(from)} — ${to ? dayKey(to) : "сейчас"}`;

export default async function FinanceSettingsPage() {
  await requireRole("OWNER");

  const [sites, rates, feeModels, taxPolicies, expenses, profile] = await Promise.all([
    prisma.site.findMany({ select: { id: true, shortName: true }, orderBy: { shortName: "asc" } }),
    prisma.consumablesRate.findMany({
      orderBy: [{ siteId: "asc" }, { effectiveFrom: "desc" }],
      include: { site: { select: { shortName: true } } },
    }),
    prisma.siteAcquiringFeeModel.findMany({
      orderBy: [{ siteId: "asc" }, { effectiveFrom: "desc" }],
      include: { site: { select: { shortName: true } } },
    }),
    prisma.ownerTaxPolicy.findMany({
      orderBy: [{ siteId: "asc" }, { effectiveFrom: "desc" }],
      include: { site: { select: { shortName: true } } },
    }),
    prisma.dailyFlowerExpense.findMany({ orderBy: { expenseDay: "desc" }, take: 30 }),
    prisma.floristFinanceProfile.findFirst({
      where: { model: "PRIMARY", active: true, effectiveTo: null },
      include: { florist: { select: { user: { select: { name: true } } } } },
    }),
  ]);

  const th = "px-3 py-2 text-left text-[11px] font-medium tracking-wide text-slate-400 uppercase";
  const td = "px-3 py-2";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — настройки расчёта"
        description="Из этих значений складывается распределяемая прибыль. Периоды не пересекаются: при изменении прежний закрывается, а старые расчёты продолжают объясняться им."
      />

      {!profile && (
        <Card>
          <CardBody className="text-sm text-amber-800">
            Профиль основного флориста не задан — расчёт доли не выполняется, а дневные расходы вносить некуда.
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Расходники · фиксированная сумма на заказ</CardTitle>
          <ConsumablesForm sites={sites} />
        </CardHeader>
        <CardBody className="p-0">
          {rates.length === 0 ? (
            <EmptyState title="Ставка не задана" description="Без неё ни один заказ не попадёт в расчёт." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Область</th>
                  <th className={th}>Сумма</th>
                  <th className={th}>Период</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{r.site?.shortName ?? "Все магазины"}</td>
                    <td className={`${td} tabular-nums`}>{formatCents(r.amountCents)}</td>
                    <td className={`${td} text-slate-500 tabular-nums`}>{period(r.effectiveFrom, r.effectiveTo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Комиссии эквайринга по магазинам</CardTitle>
          <FeeModelForm sites={sites} configuredSiteIds={[...new Set(feeModels.map((m) => m.siteId))]} />
        </CardHeader>
        <CardBody className="p-0">
          {feeModels.length === 0 ? (
            <EmptyState title="Моделей нет" description="Там, где нет фактической комиссии, заказ в расчёт не попадёт." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Магазин</th>
                  <th className={th}>Процент</th>
                  <th className={th}>Фикс</th>
                  <th className={th}>Период</th>
                </tr>
              </thead>
              <tbody>
                {feeModels.map((m) => (
                  <tr key={m.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{m.site.shortName}</td>
                    <td className={`${td} tabular-nums`}>{(m.percentBp / 100).toFixed(2)}%</td>
                    <td className={`${td} tabular-nums`}>{formatCents(m.fixedCents)}</td>
                    <td className={`${td} text-slate-500 tabular-nums`}>{period(m.effectiveFrom, m.effectiveTo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Налоговая политика владельца</CardTitle>
          <TaxPolicyForm sites={sites} />
        </CardHeader>
        <CardBody className="p-0">
          <div className="px-3 pt-2 text-xs text-slate-500">
            Флористы видят 100% собранного налога как расход бизнеса всегда. Этот процент влияет только на вашу
            картину прибыли и наружу не отдаётся.
          </div>
          {taxPolicies.length === 0 ? (
            <EmptyState title="Политика не задана" description="Начисление флористу считается и без неё." />
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Область</th>
                  <th className={th}>Реальный расход</th>
                  <th className={th}>Период</th>
                </tr>
              </thead>
              <tbody>
                {taxPolicies.map((p) => (
                  <tr key={p.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{p.site?.shortName ?? "Все магазины"}</td>
                    <td className={`${td} tabular-nums`}>{(p.actualShareBp / 100).toFixed(2)}%</td>
                    <td className={`${td} text-slate-500 tabular-nums`}>{period(p.effectiveFrom, p.effectiveTo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Дневные расходы на цветы · последние 30</CardTitle>
          {profile && <FlowerExpenseForm />}
        </CardHeader>
        <CardBody className="p-0">
          {expenses.length === 0 ? (
            <EmptyState title="Расходы не внесены" description="Без закупки день не считается целиком." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>День</th>
                  <th className={th}>Сумма</th>
                  <th className={th}>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-b border-slate-50 last:border-0">
                    <td className={`${td} tabular-nums`}>{dayKey(e.expenseDay)}</td>
                    <td className={`${td} tabular-nums`}>{formatCents(e.amountCents)}</td>
                    <td className={`${td} text-slate-500`}>{e.comment ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
