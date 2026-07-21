import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFlorist } from "@/lib/rbac";
import { getForFlorist } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { listActiveHandoffTargets } from "@/modules/florists/service";
import { loadOrderCommunicationsCard } from "@/integrations/quo/communicationsService";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import { Card, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { CopyButton } from "@/components/CopyButton";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatMoney } from "@/lib/money";
import { fmtDate, fmtDateTime, formatOrderNumber } from "@/lib/format";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { FloristOrderActions } from "./FloristOrderActions";

export const dynamic = "force-dynamic";

export default async function FloristOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireFlorist();
  const order = await getForFlorist(id, user.floristId);
  if (!order) notFound();

  const comm = await loadOrderCommunicationsCard(prisma, id).catch(() => ({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined }));
  const handoffTargets = await listActiveHandoffTargets(prisma, user.floristId).catch(() => []);

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${order.addressLine}, ${order.city} ${order.zip}`
  )}`;

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <Link href="/dashboard/f" className="text-sm text-slate-500 hover:underline">← Мои заказы</Link>

      <Card className="overflow-hidden">
        {order.items[0]?.image && (
          <ZoomableImage src={order.items[0].image} alt="" className="h-56 w-full object-cover" />
        )}
        <CardBody className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-lg font-bold text-slate-800">{formatOrderNumber(order.orderNumber)}</h1>
              <div className="text-sm text-slate-500">{order.site.name}</div>
            </div>
            <OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />
          </div>

          {/* Товары */}
          <div className="space-y-2">
            {order.items.map((it) => (
              <div key={it.id} className="flex items-center gap-3 rounded-lg bg-slate-50 p-2">
                {it.image && (
                  <ZoomableImage src={it.image} alt="" className="h-12 w-12 rounded object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800">{it.name} × {it.quantity}</div>
                  <OrderItemComposition variantName={it.variantName} floristComposition={it.floristComposition} />
                </div>
              </div>
            ))}
          </div>

          {/* Ключевая информация */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <KV label="Дата доставки" value={fmtDate(order.deliveryDate)} />
            <KV label="Интервал" value={order.deliveryWindow} />
            <KV label="Получатель" value={order.recipientName} />
            <KV label="Телефон получателя" value={order.recipientPhone} />
            <div className="col-span-2">
              <KV label="Адрес" value={`${order.addressLine}${order.apartment ? `, ${order.apartment}` : ""}, ${order.city} ${order.zip}`} />
            </div>
            <KV label="Заказчик" value={order.senderName} />
            <KV label="Телефон заказчика" value={order.senderPhone} />
            {order.readyAt && <KV label="Время готовности" value={fmtDateTime(order.readyAt)} />}
          </div>

          {/* Цена флориста */}
          <div className="rounded-lg bg-slate-800 px-4 py-3 text-center">
            <div className="text-xs text-slate-300">Ваша цена изготовления</div>
            <div className="text-2xl font-bold text-white">{formatMoney(order.floristTotal)}</div>
          </div>

          {/* Полная раскладка — только если владелец включил режим FULL для этого флориста */}
          {order.finance && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-medium text-slate-500">Полная раскладка заказа</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <KV label="Сумма товаров" value={formatMoney(order.finance.itemsTotal)} />
                <KV label="Итог клиента" value={formatMoney(order.finance.customerTotal)} />
                <KV label="Налог" value={formatMoney(order.finance.tax)} />
                <KV label="Доставка (клиент)" value={formatMoney(order.finance.deliveryCustomerCost)} />
                <KV label="Чаевые" value={formatMoney(order.finance.tip)} />
                <KV label="Скидка" value={formatMoney(order.finance.discount)} />
              </div>
            </div>
          )}

          {/* Открытка */}
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Текст открытки</span>
              <CopyButton text={order.cardMessage} />
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{order.cardMessage || "—"}</p>
          </div>

          {/* Заметка */}
          {order.customerNote && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="mb-1 text-xs font-medium text-amber-700">Customer note</div>
              <p className="whitespace-pre-wrap text-sm text-amber-900">{order.customerNote}</p>
            </div>
          )}

          {/* Фото готового букета */}
          {order.bouquetPhotoUrl && (
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">Фото готового букета</div>
              <ZoomableImage src={order.bouquetPhotoUrl} alt="" className="h-40 w-full rounded-lg object-cover" />
            </div>
          )}

          {/* Быстрые действия */}
          <div className="grid grid-cols-2 gap-2">
            <a href={mapsUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-300 py-2.5 text-center text-sm font-medium text-slate-700">
              🗺 Google Maps
            </a>
            <a href={`tel:${order.recipientPhone}`} className="rounded-lg border border-slate-300 py-2.5 text-center text-sm font-medium text-slate-700">
              📞 Позвонить
            </a>
          </div>
        </CardBody>
      </Card>

      {/* Общение (SMS/звонки) — единый блок QUO, доступен флористу. */}
      <OrderCommunications
        orderId={order.id}
        customerPhone={order.senderPhone}
        recipientPhone={order.recipientPhone}
        storeHasQuoNumber={comm.storeHasQuoNumber}
        communications={comm.communications}
        storeTimeZone={comm.storeTimeZone}
      />

      {/* Основные кнопки процесса */}
      <div className="sticky bottom-0 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
        <FloristOrderActions orderId={order.id} orderStatus={order.orderStatus} assignmentStatus={order.assignmentStatus} florists={handoffTargets} />
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-slate-800">{value}</div>
    </div>
  );
}
