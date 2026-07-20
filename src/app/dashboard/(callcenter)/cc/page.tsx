import Link from "next/link";
import { listForCallCenter, type OrderFilters } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { fmtDate, formatOrderNumber } from "@/lib/format";
import { OrderFiltersBar } from "@/app/dashboard/(owner)/orders/OrderFiltersBar";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export default async function CallCenterOrders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const filters: OrderFilters = {
    // По умолчанию показываем «Сегодня» — совпадает с подсвеченной вкладкой (OrderFiltersBar).
    preset:
      (sp.preset as OrderFilters["preset"]) ||
      (sp.date || sp.status || sp.siteId ? undefined : "today"),
    date: sp.date,
    status: sp.status as OrderStatus | undefined,
    siteId: sp.siteId,
    search: sp.search,
  };

  const [orders, sites] = await Promise.all([
    listForCallCenter(filters),
    prisma.site.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Заказы</h1>
        <span className="text-sm text-slate-500">{orders.length} шт.</span>
      </div>

      <OrderFiltersBar
        sites={sites.map((s) => ({ id: s.id, name: s.shortName }))}
        florists={[]}
        current={filters}
        basePath="/dashboard/cc"
        showFloristFilter={false}
      />

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
              <th className="px-3 py-2">Заказ</th>
              <th className="px-3 py-2">Товар</th>
              <th className="px-3 py-2">Доставка</th>
              <th className="px-3 py-2">Получатель</th>
              <th className="px-3 py-2">Адрес</th>
              <th className="px-3 py-2">Статус</th>
              <th className="px-3 py-2">Флорист</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-slate-50 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <Link href={`/dashboard/cc/${o.id}`} className="flex items-center gap-2 font-medium text-slate-800">
                    <span className="h-2 w-2 rounded-full" style={{ background: o.site.colorTag }} />
                    {formatOrderNumber(o.orderNumber)}
                  </Link>
                  <div className="text-xs text-slate-400">{o.site.name}</div>
                </td>
                <td className="px-3 py-2 max-w-[160px] truncate">{o.items[0]?.name}{o.items.length > 1 && ` +${o.items.length - 1}`}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div>{fmtDate(o.deliveryDate)}</div>
                  <div className="text-xs text-slate-400">{o.deliveryWindow}</div>
                </td>
                <td className="px-3 py-2">{o.recipientName}<div className="text-xs text-slate-400">{o.recipientPhone}</div></td>
                <td className="px-3 py-2 max-w-[160px] truncate text-slate-500">{o.addressLine}, {o.city}</td>
                <td className="px-3 py-2"><OrderStatusBadge status={o.orderStatus} paymentFailed={o.paymentFailed} /></td>
                <td className="px-3 py-2 whitespace-nowrap">{o.currentFloristName ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-400">Заказов не найдено</div>}
      </Card>
    </div>
  );
}
