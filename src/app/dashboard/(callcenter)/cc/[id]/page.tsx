import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForCallCenter } from "@/modules/orders/queries";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge, DeliveryStatusBadge } from "@/components/StatusBadge";
import { CopyButton } from "@/components/CopyButton";
import { ZoomableImage } from "@/components/ImageLightbox";
import { fmtDate, fmtDateTime, formatOrderNumber } from "@/lib/format";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { CallCenterControls } from "./CallCenterControls";

export const dynamic = "force-dynamic";

export default async function CallCenterOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForCallCenter(id);
  if (!order) notFound();

  return (
    <div className="space-y-4">
      <Link href="/dashboard/cc" className="text-sm text-slate-500 hover:underline">← Все заказы</Link>

      <div className="flex flex-wrap items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: order.site.colorTag }} />
        <h1 className="text-xl font-bold text-slate-800">{formatOrderNumber(order.orderNumber)}</h1>
        <span className="text-sm text-slate-500">{order.site.name}</span>
        <OrderStatusBadge status={order.orderStatus} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
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

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Отправитель</CardTitle></CardHeader>
              <CardBody className="space-y-1 text-sm">
                <div className="font-medium text-slate-800">{order.senderName}</div>
                <div className="text-slate-600">{order.senderPhone}</div>
                <div className="text-slate-600">{order.senderEmail ?? "—"}</div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader><CardTitle>Получатель</CardTitle></CardHeader>
              <CardBody className="space-y-1 text-sm">
                <div className="font-medium text-slate-800">{order.recipientName}</div>
                <div className="text-slate-600">{order.recipientPhone}</div>
                <div className="text-slate-600">{order.recipientEmail ?? "—"}</div>
                <div className="text-slate-600">{order.addressLine}{order.apartment ? `, ${order.apartment}` : ""}, {order.city} {order.zip}</div>
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="flex items-center justify-between"><CardTitle>Открытка</CardTitle><CopyButton text={order.cardMessage} /></CardHeader>
              <CardBody><p className="whitespace-pre-wrap text-sm text-slate-700">{order.cardMessage || "—"}</p></CardBody>
            </Card>
            <Card>
              <CardHeader className="flex items-center justify-between"><CardTitle>Customer note</CardTitle><CopyButton text={order.customerNote} /></CardHeader>
              <CardBody><p className="whitespace-pre-wrap text-sm text-slate-700">{order.customerNote || "—"}</p></CardBody>
            </Card>
          </div>

          {/* Доставка (без стоимости) */}
          <Card>
            <CardHeader><CardTitle>Доставка</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <div><div className="text-xs text-slate-400">Дата</div><div>{fmtDate(order.deliveryDate)}</div></div>
              <div><div className="text-xs text-slate-400">Интервал</div><div>{order.deliveryWindow}</div></div>
              <div><div className="text-xs text-slate-400">Статус</div><DeliveryStatusBadge status={order.deliveryStatus} /></div>
              <div><div className="text-xs text-slate-400">Tracking</div>{order.trackingUrl ? <a href={order.trackingUrl} className="text-blue-600 underline" target="_blank" rel="noreferrer">Открыть</a> : "—"}</div>
              <div><div className="text-xs text-slate-400">Флорист</div><div>{order.currentFloristName ?? "—"}</div></div>
            </CardBody>
          </Card>

          {/* Сообщения */}
          <Card>
            <CardHeader><CardTitle>История сообщений</CardTitle></CardHeader>
            <CardBody className="p-0">
              {order.messages.length === 0 ? (
                <div className="px-4 py-4 text-sm text-slate-400">Сообщений нет</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {order.messages.map((m) => (
                    <li key={m.id} className="px-4 py-2 text-sm">
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{m.channel}</span>
                        <span>{m.direction === "OUTBOUND" ? "→ клиенту" : "← от клиента"}</span>
                        <span>{fmtDateTime(m.createdAt)}</span>
                      </div>
                      <div className="mt-0.5 text-slate-700">{m.body}</div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <div className="sticky top-4">
            <CallCenterControls
              orderId={order.id}
              order={{
                orderStatus: order.orderStatus,
                deliveryDate: format(new Date(order.deliveryDate), "yyyy-MM-dd"),
                deliveryWindow: order.deliveryWindow,
                recipientName: order.recipientName,
                recipientPhone: order.recipientPhone,
                recipientEmail: order.recipientEmail,
                addressLine: order.addressLine,
                apartment: order.apartment,
                city: order.city,
                zip: order.zip,
                cardMessage: order.cardMessage,
                customerNote: order.customerNote,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
