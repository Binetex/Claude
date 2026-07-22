import { listForCallCenter, type OrderFilters } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { OrderFiltersBar } from "@/app/dashboard/(owner)/orders/OrderFiltersBar";
import { OrdersTable } from "@/app/dashboard/(owner)/orders/OrdersTable";
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

      {/* UI списка — как в главной админке, но без цен и без колонки флориста. */}
      <OrdersTable
        orders={orders}
        hideFinance
        hrefBase="/dashboard/cc"
        groupByDay={filters.preset === "all"}
      />
    </div>
  );
}
