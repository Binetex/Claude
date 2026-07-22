import Link from "next/link";
import { getOwnerDashboard } from "@/modules/orders/metrics";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge, AssignmentStatusBadge } from "@/components/StatusBadge";
import { PageHeader, StatCard, EmptyState } from "@/components/ui/misc";
import { formatMoney } from "@/lib/money";
import { fmtDate, formatOrderNumber } from "@/lib/format";
import { CircleCheck } from "lucide-react";

export const dynamic = "force-dynamic";

function OrderRow({
  href,
  orderNumber,
  primary,
  meta,
  badge,
}: {
  href: string;
  orderNumber: string;
  primary: string;
  meta: string;
  badge: React.ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-800">{orderNumber}</span>
            <span className="truncate text-xs text-slate-500">{primary}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">{meta}</div>
        </div>
        <div className="shrink-0">{badge}</div>
      </Link>
    </li>
  );
}

export default async function DashboardPage() {
  const { metrics, attention, upcoming } = await getOwnerDashboard();

  return (
    <div className="space-y-6">
      <PageHeader title="Дашборд" description="Оперативная сводка по заказам за сегодня" />

      {/* Оперативные показатели */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Заказы сегодня" value={metrics.ordersToday} />
        <StatCard label="Заказы завтра" value={metrics.ordersTomorrow} />
        <StatCard label="Без флориста" value={metrics.unassigned} tone={metrics.unassigned > 0 ? "danger" : "default"} />
        <StatCard label="Ожидают принятия" value={metrics.awaitingAccept} tone={metrics.awaitingAccept > 0 ? "warning" : "default"} />
        <StatCard label="В работе" value={metrics.inProgress} />
        <StatCard label="Готовы" value={metrics.ready} tone={metrics.ready > 0 ? "success" : "default"} />
        <StatCard label="В пути" value={metrics.inTransit} />
        <StatCard label="Доставлены сегодня" value={metrics.deliveredToday} tone="success" />
      </div>

      {/* Финансы — сгруппированным блоком */}
      <Card className="p-4">
        <div className="mb-3 text-[11px] font-medium tracking-wide text-slate-400 uppercase">Финансы сегодня</div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: "Выручка", value: formatMoney(metrics.revenueToday), tone: "text-emerald-600" },
            { label: "Расходы на флористов", value: formatMoney(metrics.floristCostToday), tone: "text-slate-900" },
            { label: "Расходы на доставку", value: formatMoney(metrics.deliveryCostToday), tone: "text-slate-900" },
            { label: "Примерная прибыль", value: formatMoney(metrics.profitToday), tone: "text-blue-600" },
          ].map((f) => (
            <div key={f.label}>
              <div className="text-xs text-slate-500">{f.label}</div>
              <div className={`mt-0.5 text-lg font-semibold tabular-nums ${f.tone}`}>{f.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Требуют внимания */}
        <Card>
          <CardHeader>
            <CardTitle>Требуют внимания{attention.length > 0 && ` · ${attention.length}`}</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {attention.length === 0 ? (
              <EmptyState icon={<CircleCheck />} title="Нет проблемных заказов" description="Всё под контролем" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {attention.map((o) => (
                  <OrderRow
                    key={o.id}
                    href={`/dashboard/orders/${o.id}`}
                    orderNumber={formatOrderNumber(o.orderNumber)}
                    primary={`${o.siteName} · ${o.recipientName}`}
                    meta={`Доставка: ${fmtDate(o.deliveryDate)}`}
                    badge={<AssignmentStatusBadge status={o.assignmentStatus} />}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Ближайшие заказы */}
        <Card>
          <CardHeader>
            <CardTitle>Ближайшие заказы</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {upcoming.length === 0 ? (
              <EmptyState title="Нет ближайших заказов" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {upcoming.map((o) => (
                  <OrderRow
                    key={o.id}
                    href={`/dashboard/orders/${o.id}`}
                    orderNumber={formatOrderNumber(o.orderNumber)}
                    primary={o.recipientName}
                    meta={`${fmtDate(o.deliveryDate)} · ${o.deliveryWindow} · ${o.florist ?? "без флориста"}`}
                    badge={<OrderStatusBadge status={o.orderStatus} paymentFailed={o.paymentFailed} />}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
