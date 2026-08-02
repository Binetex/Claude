import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatMoney } from "@/lib/money";
import { getReviewQueue, type ReviewOrder } from "@/modules/finance/review";
import { AccrueOrderButton } from "./AccrueOrderButton";

export const dynamic = "force-dynamic";

const reasonText: Record<ReviewOrder["reason"], string> = {
  NO_FLORIST: "нет исполнителя",
  FLORIST_PRICE_MISSING: "не задана цена флориста",
  NO_FINANCE_PROFILE: "у флориста не задана модель оплаты",
};

function OrdersTable({ orders, emptyText }: { orders: ReviewOrder[]; emptyText: string }) {
  if (orders.length === 0) return <EmptyState title={emptyText} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
            <th className="py-2 pr-3 font-medium">Дата</th>
            <th className="py-2 pr-3 font-medium">Заказ</th>
            <th className="py-2 pr-3 font-medium">Магазин</th>
            <th className="py-2 pr-3 font-medium">Флорист</th>
            <th className="py-2 pr-3 text-right font-medium">Сумма заказа</th>
            <th className="py-2 pr-3 font-medium">Причина</th>
            <th className="py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-slate-50 last:border-0">
              <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                {o.deliveryDate.toISOString().slice(0, 10)}
              </td>
              <td className="py-2.5 pr-3">
                <Link href={`/dashboard/orders/${o.id}`} className="text-blue-600 hover:underline">
                  {o.orderNumber}
                </Link>
              </td>
              <td className="py-2.5 pr-3 text-slate-500">{o.siteShortName}</td>
              <td className="py-2.5 pr-3 text-slate-600">{o.floristName ?? "—"}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-slate-600">{formatMoney(o.customerTotal)}</td>
              <td className="py-2.5 pr-3 text-xs text-amber-700">{reasonText[o.reason]}</td>
              <td className="py-2.5 text-right">
                {o.reason !== "NO_FLORIST" && <AccrueOrderButton orderId={o.id} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function FinanceReviewPage() {
  await requireRole("OWNER");
  const queue = await getReviewQueue();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Разбор доставленных заказов"
        description="Заказы, доставленные без начисления. Исторический backfill Shopify сюда не попадает — у тех заказов исполнителя не было и не будет."
      />

      {queue.disabledReason && (
        <Card>
          <CardBody className="text-sm text-slate-600">
            <div className="font-medium text-slate-800">Начисления выключены</div>
            <div className="mt-1 text-slate-500">
              {queue.disabledReason}. Пока гейт закрыт, очередь не наполняется.
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Доставлено без исполнителя · {queue.noFlorist.length}</CardTitle>
        </CardHeader>
        <CardBody className="px-4 py-0">
          <OrdersTable
            orders={queue.noFlorist}
            emptyText="Все доставленные заказы имеют исполнителя"
          />
        </CardBody>
        {queue.noFlorist.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            Назначьте флориста в карточке заказа, затем вернитесь сюда и запустите начисление.
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Нужна сумма · {queue.needsPrice.length}</CardTitle>
        </CardHeader>
        <CardBody className="px-4 py-0">
          <OrdersTable orders={queue.needsPrice} emptyText="Все начисления посчитаны" />
        </CardBody>
        {queue.needsPrice.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            Цена флориста по этим заказам не задана. Полную стоимость клиента вместо неё не берём —
            укажите сумму вручную в карточке заказа и начислите.
          </div>
        )}
      </Card>
    </div>
  );
}
