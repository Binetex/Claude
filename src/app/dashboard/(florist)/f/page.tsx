import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
import { listForFlorist, type OrderFilters } from "@/modules/orders/queries";
import { Card } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatMoney } from "@/lib/money";
import { fmtDate, formatOrderNumber } from "@/lib/format";
import { PurchaseListBlock } from "@/components/PurchaseListBlock";
import { FloristAcceptDecline } from "./FloristCardActions";

export const dynamic = "force-dynamic";

const tabs = [
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
  const preset = (sp.tab as OrderFilters["preset"]) || "today";
  const orders = await listForFlorist(user.floristId, { preset });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Мои заказы</h1>
        <Link href="/dashboard/f/print-notes" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">Открытки для печати</Link>
      </div>

      {/* Список закупки на сегодня — только назначенные этому флористу заказы */}
      <PurchaseListBlock floristId={user.floristId} />

      {/* Вкладки */}
      <div className="flex gap-2 overflow-x-auto">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/f?tab=${t.key}`}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${
              preset === t.key ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {orders.length === 0 && (
        <div className="py-12 text-center text-sm text-slate-400">Заказов нет</div>
      )}

      <div className="space-y-3">
        {orders.map((o) => (
          <Card key={o.id} className="overflow-hidden">
            <Link href={`/dashboard/f/${o.id}`} className="block">
              {o.items[0]?.image && (
                <ZoomableImage src={o.items[0].image} alt="" className="h-44 w-full object-cover" />
              )}
              <div className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-semibold text-slate-800">{o.items[0]?.name}{o.items.length > 1 && ` +${o.items.length - 1}`}</div>
                    <div className="text-sm text-slate-500">{formatOrderNumber(o.orderNumber)} · {o.site.name}</div>
                  </div>
                  <OrderStatusBadge status={o.orderStatus} />
                </div>
                <div className="grid grid-cols-2 gap-1 text-sm text-slate-600">
                  <div>📅 {fmtDate(o.deliveryDate)}</div>
                  <div>🕐 {o.deliveryWindow}</div>
                  <div className="col-span-2">📍 {o.addressLine}, {o.city}</div>
                </div>
                <div className="text-lg font-bold text-slate-800">💵 {formatMoney(o.floristTotal)}</div>
              </div>
            </Link>
            {o.assignmentStatus === "ASSIGNED" && (
              <div className="px-4 pb-4">
                <FloristAcceptDecline orderId={o.id} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
