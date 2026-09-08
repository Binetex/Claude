import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { CopyButton } from "@/components/CopyButton";
import { loadConsumableItems, loadOrdersWithConsumables, totalsFor } from "@/modules/consumables/service";
import { UsageCell } from "../UsageCell";

export const dynamic = "force-dynamic";

/**
 * День: заказы строками, расходники колонками. Здесь и происходит вся ежедневная работа —
 * отметить коробку и конверт, при необходимости поправить любое посчитанное число.
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

  return (
    <div className="space-y-4">
      <Link href="/dashboard/consumables" className="text-sm text-slate-400 hover:text-slate-600">← Журнал</Link>

      <PageHeader
        title={day.split("-").reverse().join(".")}
        description="Пустая ячейка — действует расчёт по составу заказа (он подсказкой). Введите своё число, чтобы перебить расчёт; сотрите — вернётся расчёт."
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Заказов: {orders.length}</span>
        <CopyButton text={numbers} label="Скопировать номера" />
      </div>

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left font-medium">Заказ</th>
                  <th className="px-2 py-2 text-left font-medium">Магазин</th>
                  {items.map((i) => (
                    <th key={i.id} className="whitespace-nowrap px-2 py-2 text-right font-medium">{i.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} className="border-b border-slate-100">
                    <td className="sticky left-0 z-10 bg-white px-3 py-1.5">
                      <Link href={`/dashboard/orders/${o.orderId}`} className="font-medium text-sky-700 hover:underline">
                        {o.orderNumber}
                      </Link>
                      {o.unknownVases > 0 && (
                        <span className="ml-1 text-amber-600" title="Ваза есть, тип не распознан по названию">?</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-slate-500">{o.siteName}</td>
                    {items.map((i) => (
                      <td key={i.id} className="px-1 py-1 text-right">
                        <UsageCell
                          orderId={o.orderId}
                          itemId={i.id}
                          auto={o.auto.get(i.id) ?? 0}
                          manual={o.manual.has(i.id) ? o.manual.get(i.id)! : null}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="bg-slate-50 font-medium">
                  <td className="sticky left-0 z-10 bg-slate-50 px-3 py-2">Итого за день</td>
                  <td />
                  {items.map((i) => (
                    <td key={i.id} className="px-2 py-2 text-right tabular-nums">{totals.get(i.id) ?? 0}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
