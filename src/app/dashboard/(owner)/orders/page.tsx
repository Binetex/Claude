import { listForOwner, countOrders, type OrderFilters } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { OrderFiltersBar } from "./OrderFiltersBar";
import { OrdersTable } from "./OrdersTable";
import { OrdersNavProvider, OrdersPendingArea } from "./OrdersNav";
import { OrdersPager } from "./OrdersPager";
import { PER_PAGE_OPTIONS, DEFAULT_PER_PAGE } from "./paging";
import { indicatorsForOrders } from "@/integrations/quo/communicationsService";
import { BulkFillCompositions } from "./BulkFillCompositions";
import { PurchaseListBlock } from "@/components/PurchaseListBlock";
import { PageHeader } from "@/components/ui/misc";
import { redirect } from "next/navigation";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export default async function OwnerOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;

  // Размер страницы — только из белого списка: значение из URL приходит от пользователя,
  // и произвольное число здесь означало бы «отдай всю базу одним запросом».
  const requestedPerPage = Number(sp.perPage);
  const perPage = (PER_PAGE_OPTIONS as readonly number[]).includes(requestedPerPage)
    ? requestedPerPage
    : DEFAULT_PER_PAGE;
  const requestedPage = Number(sp.page);
  const page = Number.isFinite(requestedPage) && requestedPage > 1 ? Math.floor(requestedPage) : 1;

  const filters: OrderFilters = {
    // По умолчанию (без явного preset/даты/сужающих фильтров) показываем «Сегодня» —
    // чтобы совпадало с подсвеченной вкладкой (см. OrderFiltersBar.activePreset).
    preset:
      (sp.preset as OrderFilters["preset"]) ||
      (sp.date || sp.status || sp.siteId || sp.floristId ? undefined : "today"),
    date: sp.date,
    from: sp.from,
    to: sp.to,
    status: sp.status as OrderStatus | undefined,
    siteId: sp.siteId,
    floristId: sp.floristId,
    search: sp.search,
    sortBy: sp.sortBy as OrderFilters["sortBy"],
    sortDir: sp.sortDir as OrderFilters["sortDir"],
    page,
    perPage,
  };

  const [orders, total, sites, florists] = await Promise.all([
    listForOwner(filters),
    countOrders(filters),
    prisma.site.findMany({ orderBy: { name: "asc" } }),
    prisma.florist.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } }),
  ]);

  // Страница за пределами выборки (ссылка из старого состояния, «назад» в браузере) — вместо
  // пустого экрана уводим на последнюю существующую.
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page > lastPage) {
    const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    p.set("page", String(lastPage));
    redirect(`/dashboard/orders?${p.toString()}`);
  }

  // Индикаторы коммуникаций (непрочитанные/пропущенные/последний контакт/preview). Best-effort:
  // недоступность QUO-таблиц не ломает список заказов.
  const commIndicators = await indicatorsForOrders(prisma, orders.map((o) => o.id)).catch(() => ({}));

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Заказы <span className="text-sm font-normal text-slate-400">{total}</span>
          </span>
        }
        actions={<BulkFillCompositions />}
      />

      <PurchaseListBlock />

      <OrdersNavProvider>
        <OrderFiltersBar
          sites={sites.map((s) => ({ id: s.id, name: s.shortName }))}
          florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
          current={filters}
        />

        <OrdersPendingArea>
          <div className="space-y-4">
            <OrdersTable orders={orders} groupByDay={filters.preset === "all"} commIndicators={commIndicators} />
            <OrdersPager page={page} perPage={perPage} total={total} />
          </div>
        </OrdersPendingArea>
      </OrdersNavProvider>
    </div>
  );
}
