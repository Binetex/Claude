import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { ExpenseDialog, DeleteExpenseDialog } from "@/components/finance/FlowerExpenseForms";
import { ExpenseHistory } from "@/components/finance/ExpenseHistory";
import { getFlowerExpenseDay } from "@/modules/finance/flowerExpenses";
import { floristPrimaryProfile } from "@/modules/finance/profile";
import { saveExpenseAction, deleteExpenseAction, previewExpenseAction } from "../actions";

export const dynamic = "force-dynamic";

/** Один день целиком: сумма, как она разошлась по заказам, и вся история правок. */
export default async function FlowerExpenseDayPage({
  params,
}: {
  params: Promise<{ floristId: string; day: string }>;
}) {
  await requireRole("OWNER");
  const { floristId, day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  // По этому флористу, а не «активный PRIMARY вообще» — см. список дней.
  const profile = await floristPrimaryProfile(floristId);
  if (!profile) notFound();

  const { row, orders, history } = await getFlowerExpenseDay(
    profile.id,
    profile.floristId,
    new Date(`${day}T00:00:00.000Z`)
  );
  const actions = { save: saveExpenseAction, remove: deleteExpenseAction, preview: previewExpenseAction };

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Расход на цветы · ${day}`}
        description={`${profile.floristName} · заказов ${row.ordersTotal}`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard/finance/florists/${floristId}/flower-expenses`}
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              К списку
            </Link>
            <ExpenseDialog
              actions={actions}
              trigger={row.expense ? "Изменить" : "Внести"}
              day={day}
              amountCents={row.expense?.amountCents ?? null}
              comment={row.expense?.comment ?? null}
              variant="default"
            />
            {row.expense && <DeleteExpenseDialog actions={actions} day={day} />}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Закупка" value={row.expense ? formatCents(row.expense.amountCents) : "не внесена"} tone={row.expense ? "default" : "danger"} />
        <StatCard label="Прибыль дня" value={row.complete ? formatCents(row.distributableCents) : "не посчитана"} />
      </div>

      {row.shareCents != null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          День посчитан, заработок флориста за него — {formatCents(row.shareCents)}. Правка суммы пересчитает день, и
          заработок изменится.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Заказы дня · {orders.length}</CardTitle>
        </CardHeader>
        <CardBody className="p-0 px-4">
          {orders.length === 0 ? (
            <div className="py-4">
              <EmptyState title="В этот день у основного флориста нет доставленных заказов" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                  <th className="py-2 pr-3 font-medium">Заказ</th>
                  <th className="py-2 pr-3 text-right font-medium">Вклад в прибыль</th>
                  <th className="py-2 text-right font-medium">В расчёте</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} className={`border-b border-slate-50 last:border-0 ${o.included ? "" : "text-slate-400"}`}>
                    <td className="py-2 pr-3">
                      <Link href={`/dashboard/orders/${o.orderId}`} className="text-blue-600 hover:underline">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {o.included ? formatCents(o.contributionCents) : "—"}
                    </td>
                    <td className="py-2 text-right">{o.included ? "да" : "нет"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>История изменений · {history.length}</CardTitle>
        </CardHeader>
        <CardBody className="p-0 px-4">
          <ExpenseHistory rows={history} />
        </CardBody>
      </Card>
    </div>
  );
}
