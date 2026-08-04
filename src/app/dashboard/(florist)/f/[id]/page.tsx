import { notFound } from "next/navigation";
import { format } from "date-fns";
import { requireFlorist } from "@/lib/rbac";
import { OrderExpensesSection } from "@/components/finance/OrderExpensesSection";
import { getForFlorist } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { listActiveHandoffTargets } from "@/modules/florists/service";
import { loadOrderCommunicationsCard } from "@/integrations/quo/communicationsService";
import {
  addOrderExpenseAction,
  removeOrderExpenseAction,
  updateOrderExpenseAction,
} from "@/app/dashboard/orderExpenseActions";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import { ContactEditDialog } from "@/app/dashboard/(owner)/orders/[id]/ContactEditDialog";
import { CardNoteCard } from "@/app/dashboard/(owner)/orders/[id]/CardNoteCard";
import { DeliveryDateDialog } from "@/app/dashboard/(owner)/orders/[id]/DeliveryDateDialog";
import { OrderStatusCard } from "@/app/dashboard/(owner)/orders/[id]/OrderStatusCard";
import { DeliveryStatusCard } from "@/app/dashboard/(owner)/orders/[id]/DeliveryStatusCard";
import { OrderPickupCard } from "@/app/dashboard/(owner)/orders/[id]/OrderPickupCard";
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { OrderItemsCard } from "@/components/orders/OrderItemsCard";
import { OrderContactCards } from "@/components/orders/OrderContactCards";
import { OrderPriceCard } from "@/components/orders/OrderPriceCard";
import { OrderQuickActions } from "@/components/orders/OrderQuickActions";
import { OrderFinanceBreakdown } from "@/components/orders/OrderFinanceBreakdown";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { recipientMapsUrl, recipientAddressLines } from "@/components/orders/address";
import { BouquetPhotoButton } from "./BouquetPhotoButton";

export const dynamic = "force-dynamic";

/**
 * Заказ в кабинете флориста.
 *
 * Порядок блоков — по тому, что нужно для изготовления: сначала что делать (товары),
 * потом кому и куда (получатель/заказчик), затем открытка, переписка и доставка.
 * Справа — цена, статус и быстрые действия; всё, что не требует решения, не занимает
 * отдельную карточку.
 *
 * Своей вёрстки здесь НЕТ вовсе: шапка, товары, контакты, открытка, SMS, доставка и быстрые
 * действия — общие компоненты, те же самые у владельца и колл-центра (см. OrderPageShell и
 * соседние в components/orders). Роль задаёт только НАБОР данных и действий.
 */
export default async function FloristOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireFlorist();
  const order = await getForFlorist(id, user.floristId);
  if (!order) notFound();

  const comm = await loadOrderCommunicationsCard(prisma, id).catch(() => ({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined, unread: { customer: 0, recipient: 0 } }));
  const handoffTargets = await listActiveHandoffTargets(prisma, user.floristId).catch(() => []);

  // Полная видимость = основной флорист: ему показываем суммы клиента, а не свою цену.
  const showsCustomerPrice = order.financeVisibility === "FULL";

  return (
    <OrderPageShell
      backHref="/dashboard/f"
      backLabel="Мои заказы"
      orderNumber={order.orderNumber}
      siteName={order.site.name}
      badges={<OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />}
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
          {/* Товары — первое, что нужно флористу. У основного флориста (полная видимость) в
              списке стоит цена КЛИЕНТА: он работает с полной суммой заказа, и «его цена» за
              позицию ему ничего не говорит. У второстепенного — по-прежнему своя. */}
          <OrderItemsCard
            showMissingCompositionHint={false}
            items={order.items.map((it) => ({
              id: it.id,
              name: it.name,
              quantity: it.quantity,
              image: it.image,
              variantImage: it.variantImage,
              variantName: it.variantName,
              floristComposition: it.floristComposition,
              prices: [
                showsCustomerPrice
                  ? { value: it.externalPrice ?? 0, label: "клиенту" }
                  : { value: it.floristItemPrice, label: "вам" },
              ],
            }))}
          />

          <OrderContactCards
            recipient={{
              name: order.recipientName,
              phone: order.recipientPhone,
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
              // E-mail заказчика флористу не отдаётся — поля нет, и строки не будет.
              name: order.senderName,
              phone: order.senderPhone,
              edit: (
                <ContactEditDialog
                  kind="sender"
                  orderId={order.id}
                  updatedAt={order.updatedAt}
                  initial={{ senderName: order.senderName, senderPhone: order.senderPhone }}
                />
              ),
            }}
          />

          {/* Полная раскладка — только если владелец включил режим FULL для этого флориста. */}
          {order.finance && <OrderFinanceBreakdown title="Полная раскладка заказа" finance={order.finance} />}

          {/* Открытка и заметки — сворачиваемо: пустая открытка не должна занимать экран. */}
          <CardNoteCard
            orderId={order.id}
            updatedAt={order.updatedAt}
            cardMessage={order.cardMessage}
            customerNote={order.customerNote}
            showPrint
            collapsible
          />

          {/* Общение (SMS/звонки) — единый блок QUO, открыт сразу. */}
          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={comm.storeHasQuoNumber}
            communications={comm.communications}
            storeTimeZone={comm.storeTimeZone}
            unread={comm.unread}
          />

          {/* Доставка целиком: курьер, Burq, точка забора и фото букета — в одном блоке. */}
          <DeliveryStatusCard
            orderId={order.id}
            orderStatus={order.orderStatus}
            deliveryInstructions={order.deliveryInstructions}
            trackingUrl={order.trackingUrl}
            bouquetPhotoUrl={order.bouquetPhotoUrl}
            deliveryPhotoUrl={order.deliveryPhotoUrl}
            storeTimeZone={comm.storeTimeZone}
            pickup={<OrderPickupCard orderId={order.id} />}
            bouquetPhotoAction={<BouquetPhotoButton orderId={order.id} photoUrl={order.bouquetPhotoUrl} />}
          />
        </>
      }
      right={
        <>
          {/* Цена изготовления — только флористу с MAKER_ONLY. При FULL владелец показывает
              суммы заказчика, и собственная себестоимость в карточке не нужна. Данные и права
              не меняются: floristTotal по-прежнему приходит, просто не отображается. */}
          {!showsCustomerPrice && <OrderPriceCard label="Ваша цена изготовления" amount={order.floristTotal} />}

          <OrderStatusCard orderId={order.id} updatedAt={order.updatedAt} orderStatus={order.orderStatus} />

          <OrderQuickActions
            orderId={order.id}
            mapsUrl={recipientMapsUrl(order)}
            handoff={{ targets: handoffTargets }}
            expense={{ actions: { add: addOrderExpenseAction, update: updateOrderExpenseAction, remove: removeOrderExpenseAction } }}
          />

          {/* Расходы появляются только когда они есть: добавление — в быстрых действиях. */}
          <OrderExpensesSection orderId={order.id} hideWhenEmpty />
        </>
      }
    />
  );
}
