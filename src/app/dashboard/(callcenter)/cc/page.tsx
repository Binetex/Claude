import { redirect } from "next/navigation";
import { listForCallCenter, countOrders, type OrderFilters } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { OrderFiltersBar } from "@/app/dashboard/(owner)/orders/OrderFiltersBar";
import { OrdersTable } from "@/app/dashboard/(owner)/orders/OrdersTable";
import { OrdersNavProvider, OrdersPendingArea } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { OrdersPager } from "@/app/dashboard/(owner)/orders/OrdersPager";
import { resolvePaging, outOfRangePageUrl } from "@/app/dashboard/(owner)/orders/paging";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const BASE_PATH = "/dashboard/cc";

export default async function CallCenterOrders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { page, perPage } = resolvePaging(sp);

  const filters: OrderFilters = {
    // По умолчанию показываем «Сегодня» — совпадает с подсвеченной вкладкой (OrderFiltersBar).
    preset:
      (sp.preset as OrderFilters["preset"]) ||
      (sp.date || sp.from || sp.to || sp.status || sp.siteId ? undefined : "today"),
    date: sp.date,
    from: sp.from,
    to: sp.to,
    status: sp.status as OrderStatus | undefined,
    siteId: sp.siteId,
    search: sp.search,
    page,
    perPage,
  };

  const [orders, total, sites] = await Promise.all([
    listForCallCenter(filters),
    countOrders(filters),
    prisma.site.findMany({ orderBy: { name: "asc" } }),
  ]);

  const outOfRange = outOfRangePageUrl(sp, BASE_PATH, { total, page, perPage });
  if (outOfRange) redirect(outOfRange);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Заказы</h1>
        <span className="text-sm text-slate-500">{total} шт.</span>
      </div>

      {/* Провайдер навигации: смена вкладки/страницы — это смена searchParams внутри уже
          открытого маршрута, и loading.tsx её НЕ покрывает. Ожидание рисует OrdersNav. */}
      <OrdersNavProvider>
        <OrderFiltersBar
          sites={sites.map((s) => ({ id: s.id, name: s.shortName }))}
          florists={[]}
          current={filters}
          basePath={BASE_PATH}
          showFloristFilter={false}
        />

        <OrdersPendingArea>
          <div className="space-y-4">
            {/* UI списка — как в главной админке, но без цен и без колонки флориста. */}
            <OrdersTable
              orders={orders}
              hideFinance
              hrefBase={BASE_PATH}
              groupByDay={filters.preset === "all"}
            />
            <OrdersPager page={page} perPage={perPage} total={total} basePath={BASE_PATH} />
          </div>
        </OrdersPendingArea>
      </OrdersNavProvider>
    </div>
  );
}
