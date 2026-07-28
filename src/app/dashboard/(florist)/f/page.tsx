import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
import { listForFlorist, type OrderFilters } from "@/modules/orders/queries";
import { OrderFiltersBar } from "@/app/dashboard/(owner)/orders/OrderFiltersBar";
import { OrdersTable } from "@/app/dashboard/(owner)/orders/OrdersTable";
import { OrdersNavProvider, OrdersPendingArea } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { PurchaseListBlock } from "@/components/PurchaseListBlock";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

/** У флориста есть своя вкладка «Готовые» — остальные совпадают с владельцем. */
const FLORIST_PRESETS = [
  { key: "today", label: "Сегодня" },
  { key: "tomorrow", label: "Завтра" },
  { key: "all", label: "Все" },
  { key: "done", label: "Готовые" },
];

export default async function FloristHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;

  const filters: OrderFilters = {
    // ?tab= — формат старых ссылок флориста; продолжаем его понимать.
    preset:
      ((sp.preset ?? sp.tab) as OrderFilters["preset"]) ||
      (sp.date || sp.from || sp.to || sp.status ? undefined : "today"),
    date: sp.date,
    from: sp.from,
    to: sp.to,
    status: sp.status as OrderStatus | undefined,
    search: sp.search,
    sortBy: sp.sortBy as OrderFilters["sortBy"],
    sortDir: sp.sortDir as OrderFilters["sortDir"],
  };

  const orders = await listForFlorist(user.floristId, filters);

  // Режим видимости берём из уже сериализованных заказов — отдельного запроса не нужно,
  // у одного флориста он одинаков для всех его заказов.
  const fullFinance = orders[0]?.financeVisibility === "FULL";

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Мои заказы <span className="text-sm font-normal text-slate-400">{orders.length}</span>
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/f/print-notes">Печать записок</Link>
          </Button>
        }
      />

      {/* Список закупки на сегодня — только назначенные этому флористу заказы */}
      <PurchaseListBlock floristId={user.floristId} />

      <OrdersNavProvider>
        <OrderFiltersBar
          sites={[]}
          florists={[]}
          current={filters}
          basePath="/dashboard/f"
          presets={FLORIST_PRESETS}
          showFloristFilter={false}
          showSiteFilter={false}
        />

        <OrdersPendingArea>
          {/* Тот же список, что у владельца, но одна сумма вместо раскладки. Какая именно —
              решает financeVisibility флориста (существующая настройка, прав не добавляет):
              FULL уже видит суммы заказчика, поэтому показываем итог заказа; MAKER_ONLY —
              свою цену изготовления, как было. */}
          <OrdersTable
            orders={orders.map((o) => ({
              ...o,
              // Раскладку заказчика в список не отдаём — только одну сумму.
              finance: undefined,
              sideAmount: fullFinance ? o.finance?.customerTotal ?? null : o.floristTotal,
            }))}
            sideAmountLabel={fullFinance ? "сумма заказа" : "вам"}
            hideFinance
            hideFlorist
            hrefBase="/dashboard/f"
            groupByDay={filters.preset === "all"}
          />
        </OrdersPendingArea>
      </OrdersNavProvider>
    </div>
  );
}
