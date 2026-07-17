import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatMoney } from "@/lib/money";
import { fmtDate, formatOrderNumber } from "@/lib/format";
import { orderStatusMeta } from "@/lib/statuses";
import type { OwnerOrder } from "@/modules/orders/serialize";

/** Единственный статус заказа — компактный бейдж ~9px (ширина по тексту). */
function StatusPill({ status, className = "" }: { status: OwnerOrder["orderStatus"]; className?: string }) {
  const m = orderStatusMeta[status];
  return (
    <span className={`inline-block w-fit rounded border px-1 py-px text-[9px] font-medium leading-none ${m.className} ${className}`}>
      {m.label}
    </span>
  );
}

function fullAddress(o: OwnerOrder): string {
  return [o.addressLine, o.apartment, o.city, o.zip].filter(Boolean).join(", ");
}

function mapsUrl(o: OwnerOrder): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress(o))}`;
}

const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Все позиции заказа — показываем сразу, без раскрытия. */
function ItemsList({ o, imgSize = "h-6 w-6", nameClass = "text-[11px]" }: { o: OwnerOrder; imgSize?: string; nameClass?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      {o.items.map((it) => (
        <div key={it.id} className="flex items-center gap-1.5">
          {it.image ? (
            <ZoomableImage src={it.image} alt={it.name} className={`${imgSize} shrink-0 rounded object-cover`} />
          ) : (
            <span className={`${imgSize} shrink-0 rounded bg-slate-100`} />
          )}
          <span className={`${nameClass} leading-tight text-slate-700`}>
            {it.name}
            {it.variantName ? <span className="font-semibold text-red-600"> {it.variantName}</span> : null}
            <span className="text-slate-400"> × {it.quantity}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Десктоп — заказ отдельной плашкой (карточкой), без колонки прибыли. */
function DesktopCard({ o }: { o: OwnerOrder }) {
  return (
    <Card className="p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-4 text-[12px]">
        {/* Заказ */}
        <div className="flex w-28 shrink-0 flex-col items-start gap-1">
          <StatusPill status={o.orderStatus} />
          <Link href={`/dashboard/orders/${o.id}`} className="font-semibold text-slate-800 hover:underline">
            {formatOrderNumber(o.orderNumber)}
          </Link>
          <span className="text-[10px] text-slate-400">{o.site.name}</span>
        </div>

        {/* Товар — расширенная область названия, картинка 60×60, имя 13px */}
        <div className="min-w-[240px] flex-[2]">
          <ItemsList o={o} imgSize="h-[60px] w-[60px]" nameClass="text-[13px]" />
        </div>

        {/* Доставка */}
        <div className="w-28 shrink-0 whitespace-nowrap">
          <div className="text-[11px] text-slate-500">{fmtDate(o.deliveryDate)}</div>
          <div className="text-[13px] font-bold text-slate-900">{o.deliveryWindow}</div>
        </div>

        {/* Получатель */}
        <div className="w-40 shrink-0">
          <div className="font-medium text-slate-800">{o.recipientName}</div>
          {o.recipientPhone && <div className="text-slate-500">{o.recipientPhone}</div>}
        </div>

        {/* Адрес */}
        <div className="min-w-[180px] flex-1">
          {fullAddress(o) ? (
            <a href={mapsUrl(o)} target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
              {fullAddress(o)}
            </a>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </div>

        {/* Флорист */}
        <div className="w-24 shrink-0 text-slate-700">{o.currentFloristName ?? "—"}</div>

        {/* Суммы (без прибыли) */}
        <div className="w-24 shrink-0 text-right leading-tight">
          <div className="font-medium text-slate-800">{formatMoney(o.finance.customerTotal)}</div>
          <div className="text-[10px] text-slate-400">сумма</div>
          <div className="mt-1 text-slate-600">{formatMoney(o.finance.floristTotal)}</div>
          <div className="text-[10px] text-slate-400">флористу</div>
        </div>
      </div>
    </Card>
  );
}

function MobileCard({ o }: { o: OwnerOrder }) {
  return (
    <Card className="p-2.5">
      <div className="flex flex-col gap-0.5">
        <StatusPill status={o.orderStatus} className="self-start" />
        <div className="flex items-baseline justify-between gap-2">
          <Link href={`/dashboard/orders/${o.id}`} className="font-semibold text-slate-800">
            {formatOrderNumber(o.orderNumber)}
          </Link>
          <span className="text-[13px] font-semibold text-slate-700">{formatMoney(o.finance.customerTotal)}</span>
        </div>
        <span className="text-[10px] text-slate-400">{o.site.name}</span>
      </div>

      <div className="mt-2">
        <ItemsList o={o} imgSize="h-[50px] w-[50px]" nameClass="text-[14px]" />
      </div>

      <div className="mt-2 space-y-1 text-[11px]">
        <div className="text-slate-500">
          {fmtDate(o.deliveryDate)} · <span className="text-[14px] font-bold text-slate-900">{o.deliveryWindow}</span>
        </div>
        <div>
          <span className="font-medium text-slate-800">{o.recipientName}</span>
          {o.recipientPhone && <span className="text-slate-500"> · {o.recipientPhone}</span>}
        </div>
        {fullAddress(o) && (
          <a href={mapsUrl(o)} target="_blank" rel="noopener noreferrer" className="block text-sky-600 hover:underline">
            📍 {fullAddress(o)}
          </a>
        )}
      </div>
    </Card>
  );
}

function DaySeparator({ date }: { date: Date | string }) {
  return <div className="px-1 pt-2 text-[11px] font-semibold text-slate-500">{fmtDate(date)}</div>;
}

export function OrdersTable({ orders, groupByDay = false }: { orders: OwnerOrder[]; groupByDay?: boolean }) {
  // Разбивка по дням (только визуально, для вкладки «Все»). Сортировка уже сделана в запросе.
  const desktopItems: React.ReactNode[] = [];
  const mobileItems: React.ReactNode[] = [];
  let prevDay: string | null = null;
  for (const o of orders) {
    if (groupByDay) {
      const day = dayKey(o.deliveryDate);
      if (day !== prevDay) {
        desktopItems.push(<DaySeparator key={`sep-${day}`} date={o.deliveryDate} />);
        mobileItems.push(<DaySeparator key={`sep-${day}`} date={o.deliveryDate} />);
        prevDay = day;
      }
    }
    desktopItems.push(<DesktopCard key={o.id} o={o} />);
    mobileItems.push(<MobileCard key={o.id} o={o} />);
  }

  return (
    <>
      {/* Десктоп — плашки заказов */}
      <div className="hidden space-y-3 md:block">
        {desktopItems}
        {orders.length === 0 && <EmptyState title="Заказов не найдено" />}
      </div>

      {/* Мобайл — карточки */}
      <div className="space-y-2.5 md:hidden">
        {mobileItems}
        {orders.length === 0 && <EmptyState title="Заказов не найдено" />}
      </div>
    </>
  );
}
