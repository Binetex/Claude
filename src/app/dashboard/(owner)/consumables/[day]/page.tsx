import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/CopyButton";
import { loadConsumableItems, loadOrdersWithConsumables, totalsFor } from "@/modules/consumables/service";
import { OrderConsumablesRow } from "../OrderConsumablesRow";

export const dynamic = "force-dynamic";

/**
 * День: заказы КАРТОЧКАМИ, как очередь отзывов, — с фотографией букета, чтобы строку узнавали
 * глазами, а не вычитывали номер. Здесь и происходит вся ежедневная работа: отметить коробку и
 * конверт, при необходимости поправить любое посчитанное число.
 */
export default async function ConsumablesDayPage({ params }: { params: Promise<{ day: string }> }) {
  const { day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  const from = new Date(`${day}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 86_400_000);

  const items = await loadConsumableItems(prisma);
  const orders = await loadOrdersWithConsumables(prisma, { from, to, items });
  if (orders.length === 0) notFound();

  const totals = totalsFor(orders, items);
  const numbers = orders.map((o) => o.orderNumber).join(", ");
  const withTotals = items.filter((i) => (totals.get(i.id) ?? 0) > 0);

  return (
    <div className="space-y-4">
      <Link href="/dashboard/consumables" className="text-sm text-slate-400 hover:text-slate-600">← Журнал</Link>

      <PageHeader
        title={day.split("-").reverse().join(".")}
        description="Вазы, донышки и записки посчитаны по составу заказа. Коробку и конверт отметьте сами; любое число можно поправить."
        actions={<CopyButton text={numbers} label="Скопировать номера" />}
      />

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2 py-3 text-xs">
          <span className="text-slate-500">Итого за день:</span>
          <span className="font-medium text-slate-700">{orders.length} заказ(ов)</span>
          {withTotals.map((i) => (
            <Badge key={i.id} className="border-slate-200 bg-slate-50 text-slate-600">{i.name}: {totals.get(i.id)}</Badge>
          ))}
        </CardBody>
      </Card>

      <div className="space-y-2">
        {orders.map((o) => (
          <OrderConsumablesRow
            key={o.orderId}
            order={{
              orderId: o.orderId,
              orderNumber: o.orderNumber,
              siteName: o.siteName,
              floristName: o.floristName,
              productSummary: o.productSummary,
              photoUrl: o.photoUrl,
              unknownVases: o.unknownVases,
              auto: Object.fromEntries(o.auto),
              manual: Object.fromEntries(o.manual),
            }}
            items={items.map((i) => ({ id: i.id, name: i.name, imageUrl: i.imageUrl, isAuto: !!i.autoRule }))}
          />
        ))}
      </div>
    </div>
  );
}
