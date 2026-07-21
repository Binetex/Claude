import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { requireFlorist } from "@/lib/rbac";
import { getForFlorist } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { listActiveHandoffTargets } from "@/modules/florists/service";
import { loadOrderCommunicationsCard } from "@/integrations/quo/communicationsService";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import { ContactEditDialog } from "@/app/dashboard/(owner)/orders/[id]/ContactEditDialog";
import { CardNoteCard } from "@/app/dashboard/(owner)/orders/[id]/CardNoteCard";
import { OrderStatusDateControls } from "@/app/dashboard/(owner)/orders/[id]/OrderStatusDateControls";
import { DeliveryStatusCard } from "@/app/dashboard/(owner)/orders/[id]/DeliveryStatusCard";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatMoney } from "@/lib/money";
import { formatOrderNumber } from "@/lib/format";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { FloristOrderActions } from "./FloristOrderActions";

export const dynamic = "force-dynamic";

export default async function FloristOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireFlorist();
  const order = await getForFlorist(id, user.floristId);
  if (!order) notFound();

  const comm = await loadOrderCommunicationsCard(prisma, id).catch(() => ({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined, unread: { customer: 0, recipient: 0 } }));
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

      {/* Получатель / Отправитель — редактируемо (OCC). Отправитель — без email. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Получатель</CardTitle>
            <ContactEditDialog
              kind="recipient"
              orderId={order.id}
              updatedAt={order.updatedAt}
              initial={{
                recipientName: order.recipientName,
                recipientPhone: order.recipientPhone,
                recipientEmail: order.recipientEmail ?? "",
                addressLine: order.addressLine,
                apartment: order.apartment ?? "",
                city: order.city,
                zip: order.zip,
              }}
            />
          </CardHeader>
          <CardBody className="space-y-1 text-sm">
            <div className="font-medium text-slate-800">{order.recipientName}</div>
            <div className="text-slate-600">{order.recipientPhone || "—"}</div>
            <div className="text-slate-600">{order.addressLine}{order.apartment ? `, ${order.apartment}` : ""}, {order.city} {order.zip}</div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Заказчик</CardTitle>
            <ContactEditDialog
              kind="sender"
              orderId={order.id}
              updatedAt={order.updatedAt}
              initial={{ senderName: order.senderName, senderPhone: order.senderPhone }}
            />
          </CardHeader>
          <CardBody className="space-y-1 text-sm">
            <div className="font-medium text-slate-800">{order.senderName}</div>
            <div className="text-slate-600">{order.senderPhone || "—"}</div>
          </CardBody>
        </Card>
      </div>

      {/* Открытка и заметка — редактируемо (OCC). */}
      <CardNoteCard orderId={order.id} updatedAt={order.updatedAt} cardMessage={order.cardMessage} customerNote={order.customerNote} />

      {/* Фото готового букета */}
      {order.bouquetPhotoUrl && (
        <Card>
          <CardHeader><CardTitle>Фото готового букета</CardTitle></CardHeader>
          <CardBody>
            <ZoomableImage src={order.bouquetPhotoUrl} alt="" className="h-40 w-full rounded-lg object-cover" />
          </CardBody>
        </Card>
      )}

      {/* Статус заказа + дата/время доставки — редактируемо (OCC). */}
      <OrderStatusDateControls
        orderId={order.id}
        updatedAt={order.updatedAt}
        orderStatus={order.orderStatus}
        deliveryDate={format(new Date(order.deliveryDate), "yyyy-MM-dd")}
        deliveryWindow={order.deliveryWindow}
      />

      {/* Статус доставки — полный блок (инструкции + курьер + Burq). */}
      <DeliveryStatusCard
        orderId={order.id}
        orderStatus={order.orderStatus}
        deliveryInstructions={order.deliveryInstructions}
        trackingUrl={order.trackingUrl}
        bouquetPhotoUrl={order.bouquetPhotoUrl}
        deliveryPhotoUrl={order.deliveryPhotoUrl}
        storeTimeZone={comm.storeTimeZone}
      />

      {/* Общение (SMS/звонки) — единый блок QUO, доступен флористу. */}
      <OrderCommunications
        orderId={order.id}
        customerPhone={order.senderPhone}
        recipientPhone={order.recipientPhone}
        storeHasQuoNumber={comm.storeHasQuoNumber}
        communications={comm.communications}
        storeTimeZone={comm.storeTimeZone}
        unread={comm.unread}
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
