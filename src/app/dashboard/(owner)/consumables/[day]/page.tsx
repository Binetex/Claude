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
export default async function ConsumablesDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ day: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { day } = await params;
  const floristId = (await searchParams).florist || undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  const from = new Date(`${day}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 86_400_000);

  const [items, florists] = await Promise.all([
    loadConsumableItems(prisma),
    prisma.florist.findMany({ where: { active: true }, select: { id: true, user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } }),
  ]);
  const orders = await loadOrdersWithConsumables(prisma, { from, to, items, floristId });
  const manualIds = items.filter((i) => !i.autoRule).map((i) => i.id);
  // Заказ, где не отмечено ни одной ручной позиции (коробка, конверт), — его легко пропустить.
  const unmarked = orders.filter((o) => !manualIds.some((id) => (o.manual.get(id) ?? 0) > 0)).length;
  const back = `/dashboard/consumables${floristId ? `?florist=${floristId}` : ""}`;

  const totals = totalsFor(orders, items);
  const numbers = orders.map((o) => o.orderNumber).join(", ");
  const withTotals = items.filter((i) => (totals.get(i.id) ?? 0) > 0);

  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-400 hover:text-slate-600">← Журнал</Link>

      <PageHeader
        title={day.split("-").reverse().join(".")}
        description="Вазы, донышки и записки посчитаны по составу заказа. Коробку и конверт отметьте нажатием; любое число можно поправить."
        actions={<CopyButton text={numbers} label="Скопировать номера" />}
      />

      {/* Флорист — как в журнале: у каждой свои заказы и своя коробка с расходниками. */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {[{ id: "", name: "Все" }, ...florists.map((f) => ({ id: f.id, name: f.user.name }))].map((f) => (
          <Link
            key={f.id || "all"}
            href={`/dashboard/consumables/${day}${f.id ? `?florist=${f.id}` : ""}`}
            className={`rounded-full border px-3 py-1 ${(floristId ?? "") === f.id ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            {f.name}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <Card><CardBody className="py-6 text-center text-sm text-slate-500">У этого флориста в этот день заказов нет.</CardBody></Card>
      ) : (
      <>
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2 py-3 text-xs">
          {unmarked > 0 && (
            <Badge className="border-amber-200 bg-amber-50 text-amber-800">Не отмечено: {unmarked} из {orders.length}</Badge>
          )}
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
      </>
      )}
    </div>
  );
}
