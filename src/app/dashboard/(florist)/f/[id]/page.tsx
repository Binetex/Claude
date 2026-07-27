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
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { FloristPriceCard, FloristQuickActions } from "@/components/orders/FloristPriceCard";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
import { OrderItemImages } from "@/components/OrderItemImages";
import { formatMoney } from "@/lib/money";
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
    <OrderPageShell
      backHref="/dashboard/f"
      backLabel="Мои заказы"
      orderNumber={order.orderNumber}
      siteName={order.site.name}
      badges={<OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />}
      deliveryDate={order.deliveryDate}
      deliveryWindow={order.deliveryWindow}
      left={
        <>
          {/* Открытка и заметка — важное, наверху (как у владельца). */}
          <CardNoteCard orderId={order.id} updatedAt={order.updatedAt} cardMessage={order.cardMessage} customerNote={order.customerNote} showPrint />

          {/* Товары. Цены — только свои: цена заказчика флористу не отдаётся сериализатором. */}
          <Card>
            <CardHeader><CardTitle>Товары</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {order.items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-4 py-3">
                    <OrderItemImages image={it.image} variantImage={it.variantImage} size="h-14 w-14" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{it.name} × {it.quantity}</div>
                      <OrderItemComposition variantName={it.variantName} floristComposition={it.floristComposition} />
                    </div>
                    <div className="text-right text-sm whitespace-nowrap">
                      <div className="text-slate-700">{formatMoney(it.floristItemPrice)}</div>
                      <div className="text-xs text-slate-400">вам</div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Получатель / Заказчик — редактируемо (OCC). */}
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

          {/* Полная раскладка — только если владелец включил режим FULL для этого флориста. */}
          {order.finance && (
            <Card>
              <CardHeader><CardTitle>Полная раскладка заказа</CardTitle></CardHeader>
              <CardBody>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
                  <FinRow label="Сумма товаров" value={formatMoney(order.finance.itemsTotal)} />
                  <FinRow label="Итог заказчика" value={formatMoney(order.finance.customerTotal)} />
                  <FinRow label="Налог" value={formatMoney(order.finance.tax)} />
                  <FinRow label="Доставка (заказчик)" value={formatMoney(order.finance.deliveryCustomerCost)} />
                  <FinRow label="Чаевые" value={formatMoney(order.finance.tip)} />
                  <FinRow label="Скидка" value={formatMoney(order.finance.discount)} />
                </div>
              </CardBody>
            </Card>
          )}

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

          {/* Фото готового букета */}
          {order.bouquetPhotoUrl && (
            <Card>
              <CardHeader><CardTitle>Фото готового букета</CardTitle></CardHeader>
              <CardBody>
                <ZoomableImage src={order.bouquetPhotoUrl} alt="" className="h-40 w-full rounded-lg object-cover" />
              </CardBody>
            </Card>
          )}

          {/* Общение (SMS/звонки) — единый блок QUO. */}
          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={comm.storeHasQuoNumber}
            communications={comm.communications}
            storeTimeZone={comm.storeTimeZone}
            unread={comm.unread}
          />
        </>
      }
      right={
        <>
          {/* Цена изготовления — только флористу с MAKER_ONLY. При FULL владелец показывает
              суммы заказчика, и собственная себестоимость в карточке не нужна. Данные и права
              не меняются: floristTotal по-прежнему приходит, просто не отображается. */}
          {order.financeVisibility !== "FULL" && <FloristPriceCard floristTotal={order.floristTotal} />}

          <FloristQuickActions mapsUrl={mapsUrl} recipientPhone={order.recipientPhone} />

          {/* Основные кнопки процесса */}
          <Card>
            <CardBody>
              <FloristOrderActions orderId={order.id} orderStatus={order.orderStatus} florists={handoffTargets} />
            </CardBody>
          </Card>

          {/* Статус заказа + дата/время доставки — редактируемо (OCC). */}
          <OrderStatusDateControls
            orderId={order.id}
            updatedAt={order.updatedAt}
            orderStatus={order.orderStatus}
            deliveryDate={format(new Date(order.deliveryDate), "yyyy-MM-dd")}
            deliveryWindow={order.deliveryWindow}
          />
        </>
      }
    />
  );
}

function FinRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  );
}
