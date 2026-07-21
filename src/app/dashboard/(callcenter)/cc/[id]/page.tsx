import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForCallCenter } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { loadOrderCommunicationsCard } from "@/integrations/quo/communicationsService";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import { ContactEditDialog } from "@/app/dashboard/(owner)/orders/[id]/ContactEditDialog";
import { CardNoteCard } from "@/app/dashboard/(owner)/orders/[id]/CardNoteCard";
import { OrderStatusDateControls } from "@/app/dashboard/(owner)/orders/[id]/OrderStatusDateControls";
import { DeliveryStatusCard } from "@/app/dashboard/(owner)/orders/[id]/DeliveryStatusCard";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatOrderNumber } from "@/lib/format";
import { OrderItemComposition } from "@/components/OrderItemComposition";

export const dynamic = "force-dynamic";

export default async function CallCenterOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForCallCenter(id);
  if (!order) notFound();

  const comm = await loadOrderCommunicationsCard(prisma, id).catch(() => ({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined, unread: { customer: 0, recipient: 0 } }));

  return (
    <div className="space-y-4">
      <Link href="/dashboard/cc" className="text-sm text-slate-500 hover:underline">← Все заказы</Link>

      <div className="flex flex-wrap items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: order.site.colorTag }} />
        <h1 className="text-xl font-bold text-slate-800">{formatOrderNumber(order.orderNumber)}</h1>
        <span className="text-sm text-slate-500">{order.site.name}</span>
        <OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Открытка и заметка — редактируемо (OCC). */}
          <CardNoteCard orderId={order.id} updatedAt={order.updatedAt} cardMessage={order.cardMessage} customerNote={order.customerNote} />

          {/* Товары */}
          <Card>
            <CardHeader><CardTitle>Товары</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {order.items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-4 py-3">
                    {it.image && (
                      <ZoomableImage src={it.image} alt="" className="h-12 w-12 rounded-lg object-cover" />
                    )}
                    <div>
                      <div className="font-medium text-slate-800">{it.name} × {it.quantity}</div>
                      <OrderItemComposition variantName={it.variantName} floristComposition={it.floristComposition} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Отправитель / Получатель — редактируемо из карточки (OCC). */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Отправитель</CardTitle>
                <ContactEditDialog
                  kind="sender"
                  orderId={order.id}
                  updatedAt={order.updatedAt}
                  initial={{ senderName: order.senderName, senderPhone: order.senderPhone, senderEmail: order.senderEmail ?? "" }}
                />
              </CardHeader>
              <CardBody className="space-y-1 text-sm">
                <div className="font-medium text-slate-800">{order.senderName}</div>
                <div className="text-slate-600">{order.senderPhone || "—"}</div>
                <div className="text-slate-600">{order.senderEmail ?? "—"}</div>
              </CardBody>
            </Card>
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
                <div className="text-slate-600">{order.recipientEmail ?? "—"}</div>
                <div className="text-slate-600">{order.addressLine}{order.apartment ? `, ${order.apartment}` : ""}, {order.city} {order.zip}</div>
              </CardBody>
            </Card>
          </div>

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

          {/* Общение (SMS/звонки) — единый блок QUO, доступен любому сотруднику. */}
          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={comm.storeHasQuoNumber}
            communications={comm.communications}
            storeTimeZone={comm.storeTimeZone}
            unread={comm.unread}
          />
        </div>

        <div className="lg:col-span-1">
          <div className="sticky top-4">
            {/* Статус заказа + дата/время доставки — редактируемо (OCC). */}
            <OrderStatusDateControls
              orderId={order.id}
              updatedAt={order.updatedAt}
              orderStatus={order.orderStatus}
              deliveryDate={format(new Date(order.deliveryDate), "yyyy-MM-dd")}
              deliveryWindow={order.deliveryWindow}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
