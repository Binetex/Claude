import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listSettingRecords, taxPolicyTotals, type SettingRecord } from "@/modules/finance/settingsAdmin";
import { TAX_POLICY_ALWAYS, taxPolicyUntil } from "@/modules/finance/taxPolicyPeriods";
import { CorrectSettingDialog, DeleteSettingDialog, type SettingRowDto } from "@/components/finance/SettingRowActions";
import { ConsumablesForm, FeeModelForm, FlowerExpenseForm, TaxPolicyForm } from "./SettingsForms";
import { correctSettingAction, deleteSettingAction, previewSettingAction } from "./settingsAdminActions";

export const dynamic = "force-dynamic";

/** Дата периода налога: «01.10.2026». Читаем UTC-части — это UTC-полночь дня, как у даты доставки. */
const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

function periodLabel(row: { effectiveFrom: Date }, until: Date | null): string {
  const from = row.effectiveFrom.getTime() <= TAX_POLICY_ALWAYS.getTime() ? null : dmy(row.effectiveFrom);
  if (!from && !until) return "всегда";
  if (!from) return `по ${dmy(until!)}`;
  return until ? `${from} – ${dmy(until)}` : `с ${from}`;
}


const th = "px-3 py-2 text-left text-[11px] font-medium tracking-wide text-slate-400 uppercase";
const td = "px-3 py-2";

/**
 * Настройки расчёта.
 *
 * У каждой записи два разных действия, и разводить их обязательно: «Новая ставка с даты»
 * в шапке карточки закрывает текущий период и прошлое не трогает, а «Изменить» у строки
 * объявляет прежнее значение ошибочным и пересобирает уже посчитанное. Первое — обычная
 * жизнь, второе может двинуть баланс флориста, поэтому и подтверждается предпросмотром.
 */
export default async function FinanceSettingsPage() {
  await requireRole("OWNER");

  const [sites, records, profile, taxTotals] = await Promise.all([
    prisma.site.findMany({ select: { id: true, shortName: true }, orderBy: { shortName: "asc" } }),
    listSettingRecords(),
    prisma.floristFinanceProfile.findFirst({
      where: { model: "PRIMARY", active: true, effectiveTo: null },
      include: { florist: { select: { user: { select: { name: true } } } } },
    }),
    taxPolicyTotals(),
  ]);

  const rates = records.filter((r) => r.entity === "CONSUMABLES_RATE");
  const feeModels = records.filter((r) => r.entity === "FEE_MODEL");
  // Налог — с датами: общая ставка первой, внутри области — по дате начала.
  const taxPolicies = records
    .filter((r) => r.entity === "TAX_POLICY")
    .sort((a, b) => (a.siteShortName ?? "").localeCompare(b.siteShortName ?? "") || (a.effectiveFrom?.getTime() ?? 0) - (b.effectiveFrom?.getTime() ?? 0));
  const taxRows = taxPolicies.map((p) => ({
    siteId: p.siteId,
    actualShareBp: p.values.entity === "TAX_POLICY" ? p.values.actualShareBp : 0,
    effectiveFrom: p.effectiveFrom ?? TAX_POLICY_ALWAYS,
  }));
  const actions = { correct: correctSettingAction, remove: deleteSettingAction, preview: previewSettingAction };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — настройки расчёта"
        description="Из этих значений складывается распределяемая прибыль. Периоды не пересекаются и смыкаются: между двумя записями не бывает дня без настройки."
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
          <ConsumablesForm sites={sites} hasRecords={rates.length > 0} />
        </CardHeader>
        {/* Таблица настроек шире телефона по существу — в ней пять колонок с датами и
            процентами. Прокрутка ЛОКАЛЬНАЯ: без неё страница целиком уезжала вправо
            (scrollWidth 437 при экране 320). */}
        <CardBody className="overflow-x-auto p-0">
          {rates.length === 0 ? (
            <EmptyState title="Ставка не задана" description="Без неё ни один заказ не попадёт в расчёт." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Область</th>
                  <th className={th}>Сумма</th>
                  <th className={`${th} text-right`}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{r.siteShortName ?? "Все магазины"}</td>
                    <td className={`${td} tabular-nums`}>
                      {r.values.entity === "CONSUMABLES_RATE" ? formatCents(r.values.amountCents) : "—"}
                    </td>
                    <RowActions record={r} />
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
          <FeeModelForm
            sites={sites}
            configuredSiteIds={[...new Set(feeModels.map((m) => m.siteId).filter((v): v is string => v != null))]}
           
          />
        </CardHeader>
        {/* Таблица настроек шире телефона по существу — в ней пять колонок с датами и
            процентами. Прокрутка ЛОКАЛЬНАЯ: без неё страница целиком уезжала вправо
            (scrollWidth 437 при экране 320). */}
        <CardBody className="overflow-x-auto p-0">
          {feeModels.length === 0 ? (
            <EmptyState title="Моделей нет" description="Там, где нет фактической комиссии, заказ в расчёт не попадёт." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Магазин</th>
                  <th className={th}>Процент</th>
                  <th className={th}>Фикс</th>
                  <th className={`${th} text-right`}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {feeModels.map((m) => (
                  <tr key={m.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{m.siteShortName}</td>
                    <td className={`${td} tabular-nums`}>
                      {m.values.entity === "FEE_MODEL" ? `${(m.values.percentBp / 100).toFixed(2)}%` : "—"}
                    </td>
                    <td className={`${td} tabular-nums`}>
                      {m.values.entity === "FEE_MODEL" ? formatCents(m.values.fixedCents) : "—"}
                    </td>
                    <RowActions record={m} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Налог в вашем доходе</CardTitle>
          <TaxPolicyForm sites={sites} hasRecords={taxPolicies.length > 0} />
        </CardHeader>
        {/* Таблица настроек шире телефона по существу — в ней пять колонок с датами и
            процентами. Прокрутка ЛОКАЛЬНАЯ: без неё страница целиком уезжала вправо
            (scrollWidth 437 при экране 320). */}
        <CardBody className="overflow-x-auto p-0">
          <div className="px-3 pt-2 text-xs text-slate-500">
            Флористы видят 100% собранного налога как расход бизнеса всегда. Этот процент влияет только на вашу
            картину прибыли, наружу не отдаётся и на долю флориста не действует. Ставка действует с указанного дня
            до следующей: новая ставка с даты прошлое до неё не меняет, «Изменить» у строки — правит её период.
          </div>
          {taxPolicies.length === 0 ? (
            <EmptyState title="Политика не задана" description="Начисление флористу считается и без неё." />
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className={th}>Область</th>
                  <th className={th}>Действует</th>
                  <th className={th}>Реальный расход</th>
                  <th className={th}>Вычтено за период</th>
                  <th className={`${th} text-right`}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {taxPolicies.map((p, i) => (
                  <tr key={p.id} className="border-b border-slate-50 last:border-0">
                    <td className={td}>{p.siteShortName ?? "Все магазины"}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{periodLabel(taxRows[i], taxPolicyUntil(taxRows, taxRows[i]))}</td>
                    <td className={`${td} tabular-nums`}>
                      {p.values.entity === "TAX_POLICY" ? `${(p.values.actualShareBp / 100).toFixed(2)}%` : "—"}
                    </td>
                    {/* Сколько из дохода ушло налогом в этом периоде — и из какого собранного налога. */}
                    <td className={`${td} tabular-nums`}>
                      {taxTotals.get(p.id) ? (
                        <>
                          <span className="font-medium text-slate-800">{formatCents(taxTotals.get(p.id)!.deductedCents)}</span>
                          <span className="text-xs text-slate-400">
                            {" "}
                            из {formatCents(taxTotals.get(p.id)!.collectedCents)} · заказов {taxTotals.get(p.id)!.orders}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">заказов нет</span>
                      )}
                    </td>
                    <RowActions record={p} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <CardTitle>Дневные расходы на цветы</CardTitle>
          {profile && <FlowerExpenseForm />}
        </CardHeader>
        <CardBody className="text-sm text-slate-600">
          Дневная закупка живёт в собственном разделе — там вся история без ограничения по давности, поиск
          пропущенных дней, исправление и удаление с историей изменений.{" "}
          <Link href="/dashboard/finance/flower-expenses" className="text-blue-600 hover:underline">
            Открыть «Расходы на цветы»
          </Link>
          .
        </CardBody>
      </Card>

      <p className="text-xs text-slate-400">
        У расходников и комиссии одно значение, и оно действует всегда: правка пересчитывает все дни расчёта, прежняя
        сумма остаётся в истории правок. Налог в вашем доходе — со своей датой начала.
      </p>
    </div>
  );

  function RowActions({ record }: { record: SettingRecord }) {
    const row: SettingRowDto = {
      id: record.id,
      entity: record.entity,
      ...(record.values.entity === "CONSUMABLES_RATE" ? { amountCents: record.values.amountCents } : {}),
      ...(record.values.entity === "FEE_MODEL"
        ? { percentBp: record.values.percentBp, fixedCents: record.values.fixedCents }
        : {}),
      ...(record.values.entity === "TAX_POLICY" ? { actualShareBp: record.values.actualShareBp } : {}),
    };
    return (
      <td className={`${td} text-right whitespace-nowrap`}>
        <div className="flex items-center justify-end gap-1">
          <CorrectSettingDialog actions={actions} row={row} />
          <DeleteSettingDialog actions={actions} row={row} />
        </div>
      </td>
    );
  }
}

