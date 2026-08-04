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
import { OrderStatusCard } from "@/app/dashboard/(owner)/orders/[id]/OrderStatusDateControls";
import { DeliveryStatusCard } from "@/app/dashboard/(owner)/orders/[id]/DeliveryStatusCard";
import { OrderPickupCard } from "@/app/dashboard/(owner)/orders/[id]/OrderPickupCard";
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { FloristPriceCard } from "@/components/orders/FloristPriceCard";
import { Calculator, Contact, MapPin, Package, Phone, UserRound } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { OrderItemImages } from "@/components/OrderItemImages";
import { formatMoney } from "@/lib/money";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { FloristQuickActions } from "./FloristQuickActions";
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
 * Своей вёрстки здесь минимум: шапка, карточки контактов и блоки доставки/открытки/SMS
 * общие с владельцем и колл-центром (см. OrderPageShell и соседние компоненты).
 */
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
          {/* Товары — первое, что нужно флористу. Цены только свои: цена заказчика ему не отдаётся. */}
          <Card>
            <CardHeader className="py-2.5"><CardTitle icon={Package}>Товары</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {/* flex-wrap + минимальная ширина текста: на телефоне под название остаётся
                    всего ~117px, и оно рассыпается по слову на строку. Цена в такой ситуации
                    переносится на свою строку и прижимается вправо, а название получает всю
                    ширину карточки. На широком экране строка по-прежнему одна. */}
                {order.items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                    <OrderItemImages image={it.image} variantImage={it.variantImage} size="h-14 w-14" />
                    <div className="min-w-[10rem] flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                        {/* На телефоне название переносится, а не обрезается: обрезка прятала
                            почти весь букет, а места по вертикали там как раз хватает. */}
                        <span className="min-w-0 break-words sm:truncate">{it.name}</span>
                        {/* Количество отдельным чипом: «× 1» в потоке текста сливается с названием. */}
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 tabular-nums">
                          ×{it.quantity}
                        </span>
                      </div>
                      {/* Флористу подсказка «состав не указан» не адресована: заполнить каталог
                          он не может, а строка повторялась бы у каждой позиции. */}
                      <OrderItemComposition
                        variantName={it.variantName}
                        floristComposition={it.floristComposition}
                        showMissingHint={false}
                      />
                    </div>
                    {/* У основного флориста (полная видимость) в списке товаров стоит цена
                        КЛИЕНТА: он работает с полной суммой заказа, и «его цена» за позицию
                        ему ничего не говорит. У второстепенного — по-прежнему своя. */}
                    <div className="ml-auto text-right whitespace-nowrap">
                      <div className="text-sm font-medium text-slate-800 tabular-nums">
                        {formatMoney(showsCustomerPrice ? (it.externalPrice ?? 0) : it.floristItemPrice)}
                      </div>
                      <div className="text-[11px] text-slate-400">{showsCustomerPrice ? "клиенту" : "вам"}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Получатель / Заказчик — редактируемо (OCC). */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="flex items-center justify-between py-2.5">
                <CardTitle icon={UserRound}>Получатель</CardTitle>
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
              <CardBody className="space-y-1.5 text-sm">
                <div className="font-medium text-slate-800">{order.recipientName}</div>
                {/* Иконки-якоря: телефон и адрес различаются с одного взгляда, без чтения. */}
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone aria-hidden className="size-3.5 shrink-0 text-slate-400" />
                  <span className="tabular-nums">{order.recipientPhone || "—"}</span>
                </div>
                <div className="flex items-start gap-2 text-slate-600">
                  <MapPin aria-hidden className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
                  <span>{order.addressLine}{order.apartment ? `, ${order.apartment}` : ""}, {order.city} {order.zip}</span>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader className="flex items-center justify-between py-2.5">
                <CardTitle icon={Contact}>Заказчик</CardTitle>
                <ContactEditDialog
                  kind="sender"
                  orderId={order.id}
                  updatedAt={order.updatedAt}
                  initial={{ senderName: order.senderName, senderPhone: order.senderPhone }}
                />
              </CardHeader>
              <CardBody className="space-y-1.5 text-sm">
                <div className="font-medium text-slate-800">{order.senderName}</div>
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone aria-hidden className="size-3.5 shrink-0 text-slate-400" />
                  <span className="tabular-nums">{order.senderPhone || "—"}</span>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Полная раскладка — только если владелец включил режим FULL для этого флориста. */}
          {order.finance && (
            <Card>
              <CardHeader className="py-2.5"><CardTitle icon={Calculator}>Полная раскладка заказа</CardTitle></CardHeader>
              <CardBody>
                <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 md:grid-cols-3">
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
          {!showsCustomerPrice && <FloristPriceCard floristTotal={order.floristTotal} />}

          <OrderStatusCard orderId={order.id} updatedAt={order.updatedAt} orderStatus={order.orderStatus} />

          <FloristQuickActions
            orderId={order.id}
            mapsUrl={mapsUrl}
            handoffTargets={handoffTargets}
            expenseActions={{ add: addOrderExpenseAction, update: updateOrderExpenseAction, remove: removeOrderExpenseAction }}
          />

          {/* Расходы появляются только когда они есть: добавление — в быстрых действиях. */}
          <OrderExpensesSection orderId={order.id} hideWhenEmpty />
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
