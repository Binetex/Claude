import { listForOwner, type OrderFilters } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { OrderFiltersBar } from "./OrderFiltersBar";
import { OrdersTable } from "./OrdersTable";
import { indicatorsForOrders } from "@/integrations/quo/communicationsService";
import { BulkFillCompositions } from "./BulkFillCompositions";
import { PurchaseListBlock } from "@/components/PurchaseListBlock";
import { PageHeader } from "@/components/ui/misc";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export default async function OwnerOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
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
  };

  const [orders, sites, florists] = await Promise.all([
    listForOwner(filters),
    prisma.site.findMany({ orderBy: { name: "asc" } }),
    prisma.florist.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } }),
  ]);

  // Индикаторы коммуникаций (непрочитанные/пропущенные/последний контакт/preview). Best-effort:
  // недоступность QUO-таблиц не ломает список заказов.
  const commIndicators = await indicatorsForOrders(prisma, orders.map((o) => o.id)).catch(() => ({}));

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Заказы <span className="text-sm font-normal text-slate-400">{orders.length}</span>
          </span>
        }
        actions={<BulkFillCompositions />}
      />

      <PurchaseListBlock />

      <OrderFiltersBar
        sites={sites.map((s) => ({ id: s.id, name: s.shortName }))}
        florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
        current={filters}
      />

      <OrdersTable orders={orders} groupByDay={filters.preset === "all"} commIndicators={commIndicators} />
    </div>
  );
}
