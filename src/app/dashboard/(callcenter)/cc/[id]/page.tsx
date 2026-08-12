import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForCallCenter } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { loadOrderCommunicationsCard } from "@/integrations/quo/communicationsService";
import { loadOrderEmails } from "@/integrations/emailFactory/read";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import { ContactEditDialog } from "@/app/dashboard/(owner)/orders/[id]/ContactEditDialog";
import { CardNoteCard } from "@/app/dashboard/(owner)/orders/[id]/CardNoteCard";
import { DeliveryDateDialog } from "@/app/dashboard/(owner)/orders/[id]/DeliveryDateDialog";
import { OrderStatusCard } from "@/app/dashboard/(owner)/orders/[id]/OrderStatusCard";
import { DeliveryStatusCard } from "@/app/dashboard/(owner)/orders/[id]/DeliveryStatusCard";
import { OrderPickupCard } from "@/app/dashboard/(owner)/orders/[id]/OrderPickupCard";
import { OrderExpensesSection } from "@/components/finance/OrderExpensesSection";
import {
  addOrderExpenseAction,
  removeOrderExpenseAction,
  updateOrderExpenseAction,
} from "@/app/dashboard/orderExpenseActions";
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { OrderItemsCard } from "@/components/orders/OrderItemsCard";
import { OrderContactCards } from "@/components/orders/OrderContactCards";
import { OrderQuickActions } from "@/components/orders/OrderQuickActions";
import { recipientAddressLines, recipientMapsUrl } from "@/components/orders/address";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { FloristAvatar } from "@/components/FloristAvatar";

export const dynamic = "force-dynamic";

/**
 * Заказ в колл-центре.
 *
 * Раскладка и компоненты — те же, что у флориста и владельца (см. OrderPageShell и соседние
 * в components/orders); своей вёрстки здесь нет. Роль отличается только НАБОРОМ данных и
 * действий: цен нет вовсе (их нет и в сериализации), назначенный флорист — справочная
 * подпись в шапке, переназначение и цена остаются владельцу.
 */
export default async function CallCenterOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForCallCenter(id);
  if (!order) notFound();

  const orderEmails = await loadOrderEmails(prisma, id).catch(() => []);
  const comm = await loadOrderCommunicationsCard(prisma, id).catch(() => ({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined, unread: { customer: 0, recipient: 0 } }));

  return (
    <OrderPageShell
      backHref="/dashboard/cc"
      backLabel="Все заказы"
      orderNumber={order.orderNumber}
      siteName={order.site.name}
      badges={
        <>
          <OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />
          {/* Назначенный флорист — только просмотр (переназначение доступно владельцу).
              Отдельной карточки под справочную подпись не заводим. */}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-0.5 pr-2.5 pl-0.5 text-xs text-slate-600">
            <FloristAvatar name={order.currentFloristName} avatarUrl={order.currentFloristAvatarUrl} size={20} />
            <span className="font-medium text-slate-700">{order.currentFloristName ?? "без флориста"}</span>
          </span>
        </>
      }
      deliveryDate={order.deliveryDate}
      deliveryWindow={order.deliveryWindow}
      rightFirstOnMobile
      deliveryAction={
        <DeliveryDateDialog
          orderId={order.id}
          updatedAt={order.updatedAt}
          deliveryDate={format(new Date(order.deliveryDate), "yyyy-MM-dd")}
          deliveryWindow={order.deliveryWindow}
        />
      }
      left={
        <>
          {/* Цен нет: колл-центру они не отдаются (в serializeForCallCenter их физически нет). */}
          <OrderItemsCard
            items={order.items.map((it) => ({
              id: it.id,
              name: it.name,
              quantity: it.quantity,
              image: it.image,
              variantImage: it.variantImage,
              variantName: it.variantName,
              floristComposition: it.floristComposition,
            }))}
          />

          <OrderContactCards
            recipient={{
              name: order.recipientName,
              phone: order.recipientPhone,
              email: order.recipientEmail ?? "",
              addressLines: recipientAddressLines(order),
              edit: (
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
              ),
            }}
            customer={{
              name: order.senderName,
              phone: order.senderPhone,
              email: order.senderEmail ?? "",
              edit: (
                <ContactEditDialog
                  kind="sender"
                  orderId={order.id}
                  updatedAt={order.updatedAt}
                  initial={{ senderName: order.senderName, senderPhone: order.senderPhone, senderEmail: order.senderEmail ?? "" }}
                />
              ),
            }}
          />

          <CardNoteCard
            orderId={order.id}
            updatedAt={order.updatedAt}
            cardMessage={order.cardMessage}
            customerNote={order.customerNote}
            collapsible
          />

          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={comm.storeHasQuoNumber}
            emails={orderEmails}
          communications={comm.communications}
            storeTimeZone={comm.storeTimeZone}
            unread={comm.unread}
          />

          <DeliveryStatusCard
            orderId={order.id}
            orderStatus={order.orderStatus}
            deliveryInstructions={order.deliveryInstructions}
            trackingUrl={order.trackingUrl}
            bouquetPhotoUrl={order.bouquetPhotoUrl}
            deliveryPhotoUrl={order.deliveryPhotoUrl}
            storeTimeZone={comm.storeTimeZone}
            pickup={<OrderPickupCard orderId={order.id} />}
          />
        </>
      }
      right={
        <>
          <OrderStatusCard orderId={order.id} updatedAt={order.updatedAt} orderStatus={order.orderStatus} />

          <OrderQuickActions
            orderId={order.id}
            mapsUrl={recipientMapsUrl(order)}
            expense={{ actions: { add: addOrderExpenseAction, update: updateOrderExpenseAction, remove: removeOrderExpenseAction } }}
          />

          <OrderExpensesSection orderId={order.id} hideWhenEmpty />
        </>
      }
    />
  );
}
