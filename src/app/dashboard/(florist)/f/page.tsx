import Link from "next/link";
import { redirect } from "next/navigation";
import { requireFlorist } from "@/lib/rbac";
import { listForFlorist, countForFlorist, type OrderFilters } from "@/modules/orders/queries";
import { OrderFiltersBar } from "@/app/dashboard/(owner)/orders/OrderFiltersBar";
import { OrdersTable } from "@/app/dashboard/(owner)/orders/OrdersTable";
import { OrdersNavProvider, OrdersPendingArea } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { OrdersPager } from "@/app/dashboard/(owner)/orders/OrdersPager";
import { resolvePaging, outOfRangePageUrl } from "@/app/dashboard/(owner)/orders/paging";
import { PurchaseListBlock } from "@/components/PurchaseListBlock";
import { NoCouriersBanner } from "@/components/orders/NoCouriersBanner";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import type { OrderStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const BASE_PATH = "/dashboard/f";

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
  const { page, perPage } = resolvePaging(sp);

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
    page,
    perPage,
  };

  const [orders, total] = await Promise.all([
    listForFlorist(user.floristId, filters),
    countForFlorist(user.floristId, filters),
  ]);

  const outOfRange = outOfRangePageUrl(sp, BASE_PATH, { total, page, perPage });
  if (outOfRange) redirect(outOfRange);

  // Режим видимости берём из уже сериализованных заказов — отдельного запроса не нужно,
  // у одного флориста он одинаков для всех его заказов.
  const fullFinance = orders[0]?.financeVisibility === "FULL";

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Мои заказы <span className="text-sm font-normal text-slate-400">{total}</span>
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/f/print-notes">Печать записок</Link>
          </Button>
        }
      />

      {/* Список закупки на сегодня — только назначенные этому флористу заказы */}
      {/* Только СВОИ заказы. Молчит, когда курьеры есть. */}
      <NoCouriersBanner floristId={user.floristId} hrefBase="/dashboard/f" />

      <PurchaseListBlock floristId={user.floristId} />

      <OrdersNavProvider>
        <OrderFiltersBar
          sites={[]}
          florists={[]}
          current={filters}
          basePath={BASE_PATH}
          presets={FLORIST_PRESETS}
          showFloristFilter={false}
          showSiteFilter={false}
        />

        <OrdersPendingArea>
          <div className="space-y-4">
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
