import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForOwner } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { OrderItemsCard } from "@/components/orders/OrderItemsCard";
import { OrderContactCards } from "@/components/orders/OrderContactCards";
import { OrderFloristPayCard, type FloristPayView } from "@/components/orders/OrderFloristPayCard";
import { OrderQuickActions } from "@/components/orders/OrderQuickActions";
import { getAvailableFloristIds, getSitePriorityFloristIds } from "@/modules/assignments/service";
import { OrderFinanceBreakdown } from "@/components/orders/OrderFinanceBreakdown";
import { recipientAddressLines, recipientMapsUrl, senderAddressLines } from "@/components/orders/address";
import { resolveProfileAt } from "@/modules/finance/profile";
import { OrderStatusBadge, PaymentStatusBadge } from "@/components/StatusBadge";
import { formatMoney } from "@/lib/money";
import { fmtDateTime } from "@/lib/format";
import { AirwallexPanel } from "./AirwallexPanel";
import { RefundDialog } from "./RefundDialog";
import { getRefundSummary } from "@/integrations/airwallex/refund";
import { UpdateCompositionButton } from "../UpdateCompositionButton";
import { OwnerPriceDialog } from "./OwnerPriceDialog";
import { ContactEditDialog } from "./ContactEditDialog";
import { CardNoteCard } from "./CardNoteCard";
import { CustomerNoteBanner } from "./CustomerNoteBanner";
import { CourierNoteCard } from "./CourierNoteCard";
import { DeliveryDateDialog } from "./DeliveryDateDialog";
import { OrderStatusCard } from "./OrderStatusCard";
import { DeliveryStatusCard } from "./DeliveryStatusCard";
import { OrderPickupCard } from "./OrderPickupCard";
import { OrderCommunications, type CommItem } from "./OrderCommunications";
import { OrderAssistantCard, type AssistantTurn } from "./OrderAssistantCard";
import { collapseSendAttempts } from "./collapseAttempts";
import { OrderExpensesSection } from "@/components/finance/OrderExpensesSection";
import {
  addOrderExpenseAction,
  removeOrderExpenseAction,
  updateOrderExpenseAction,
} from "@/app/dashboard/orderExpenseActions";
import { markOrderCommunicationsRead, countUnreadBySide, parseAttachments } from "@/integrations/quo/communicationsService";
import { loadOrderEmailPanel } from "@/integrations/emailFactory/read";
import { FloristAvatar } from "@/components/FloristAvatar";
import { ChargesDialog } from "./ChargesDialog";
import { MarketingMarkCard } from "./MarketingMarkCard";
import { BouquetPhotoButton } from "@/components/orders/BouquetPhotoButton";

export const dynamic = "force-dynamic";

/**
 * Заказ у владельца.
 *
 * Раскладка — та же, что в кабинете флориста, и собрана из тех же компонентов: своей вёрстки
 * товаров, контактов и доставки здесь больше нет. Владельческое живёт не в отдельных больших
 * карточках, а внутри общей компоновки: переназначение флориста — плитка «Быстрых действий»,
 * ручная цена — карандаш на плашке цены. Внизу страницы, отдельно от блоков заказа, — Airwallex
 * и история назначений.
 *
 * Блока «Финансы» здесь СОЗНАТЕЛЬНО НЕТ: он показывал «≈ Прибыль» по плоской формуле
 * computeEstimatedProfit, не знающей ни про модели PRIMARY/SECONDARY, ни про резерв налога,
 * ни про дневной расчёт. Возвращать его нельзя — заработок считает финансовый модуль.
 */
export default async function OwnerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForOwner(id);
  if (!order) notFound();

  const florists = await prisma.florist.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } });

  // Сводка возвратов — best-effort и только когда есть что показывать: платёж Airwallex.
  // Ошибка или недоступность Airwallex не должна ронять карточку заказа, поэтому catch.
  const refundSummary = order.airwallex ? await getRefundSummary(order.id).catch(() => null) : null;

  // Заказ без флориста: отличаем «все заняты в этот день» от «флористов нет вовсе».
  // Считаем на чтении — хранить нечего, ответ всегда соответствует текущим настройкам.
  const noFloristReason = order.currentFloristId
    ? null
    : await (async () => {
        // siteId в сериализованном заказе нет, а запрос по первичному ключу дешевле, чем
        // тащить лишнее поле через общую сериализацию ради одного экрана.
        const row = await prisma.order.findUnique({ where: { id }, select: { siteId: true, deliveryDate: true } });
        if (!row) return null;
        const priority = await getSitePriorityFloristIds(row.siteId);
        if (priority.length === 0) return "нет активных флористов для этого магазина";
        const available = await getAvailableFloristIds(row.siteId, row.deliveryDate);
        return available.length === 0 ? "на эту дату нет доступных флористов — все отмечены выходными" : null;
      })();

  // Чем оплачивается заказ назначенному флористу. Профиль резолвится НА ДАТУ ДОСТАВКИ, а не
  // на «сейчас»: модель оплаты меняется во времени, и июльский заказ обязан читаться по
  // июльским правилам, даже если в августе флориста перевели на другую модель.
  const pay: FloristPayView = await resolveFloristPay(order.currentFloristId, order.deliveryDate, {
    floristTotal: order.finance.floristTotal,
    priceMode: order.priceMode,
  });
  // Бейдж назначения не показываем вовсе: назначение происходит автоматически, а «нет флориста»
  // видно по самому блоку назначения ниже и по дашборду. Дублировать статус заказа не нужно.
  // Оплату показываем, только когда она НЕ обычная: «Оплачен» рядом со статусом «Оплачен» —
  // это одно и то же слово дважды.
  const showPayment = order.paymentStatus !== "PAID";

  // QUO: история коммуникаций + номер магазина. Обёрнуто в try/catch — временная недоступность
  // не должна ронять карточку заказа (историю читаем из локальной БД, не из QUO).
  let communications: CommItem[] = [];
  let storeHasQuoNumber = false;
  let storeTimeZone: string | undefined;
  // Переписка по email — своя таблица и своя вкладка; сбой её загрузки не должен ронять карточку.
  const emailPanel = await loadOrderEmailPanel(prisma, id).catch(() => ({ emails: [], customerEmail: null }));

  let commUnread = { customer: 0, recipient: 0 };
  try {
    // Непрочитанные по сторонам считаем ДО пометки прочитанным (иначе всегда 0).
    commUnread = await countUnreadBySide(prisma, id).catch(() => commUnread);
    // Открытие карточки → помечаем входящие SMS и пропущенные звонки прочитанными (командно).
    await markOrderCommunicationsRead(prisma, id).catch(() => 0);
    const [comms, siteQuo] = await Promise.all([
      prisma.orderCommunication.findMany({
        where: { orderId: id },
        orderBy: { occurredAt: "desc" },
        take: 200,
        select: { id: true, type: true, direction: true, status: true, partyRole: true, externalPhone: true, messageText: true, durationSeconds: true, recordingUrl: true, transcript: true, summary: true, attachmentsJson: true, occurredAt: true, sentByUserId: true, sendKey: true },
      }),
      prisma.site.findFirst({ where: { orders: { some: { id } } }, select: { quoPhoneNumberId: true, quoEnabled: true, timezone: true } }),
    ]);
    const senderIds = [...new Set(comms.map((c) => c.sentByUserId).filter((x): x is string => !!x))];
    const users = senderIds.length ? await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, name: true } }) : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    // Попытки одной отправки (провал + удачный повтор) сворачиваются в одно сообщение —
    // иначе лента показывает их как дубли клиенту (см. collapseAttempts.ts).
    communications = collapseSendAttempts(
      comms.map((c) => ({
        id: c.id, type: c.type, direction: c.direction, status: c.status, partyRole: c.partyRole,
        externalPhone: c.externalPhone, messageText: c.messageText, durationSeconds: c.durationSeconds,
        recordingUrl: c.recordingUrl, transcript: c.transcript, summary: c.summary,
        attachments: parseAttachments(c.attachmentsJson),
        occurredAt: c.occurredAt.toISOString(), sentByName: c.sentByUserId ? nameById.get(c.sentByUserId) ?? null : null,
        sendKey: c.sendKey,
      }))
    );
    storeHasQuoNumber = !!(siteQuo?.quoPhoneNumberId && siteQuo?.quoEnabled);
    storeTimeZone = siteQuo?.timezone ?? undefined;
  } catch {
    // QUO-таблицы недоступны — блок общения просто не покажет историю.
  }

  // Что ассистент сделал с входящими по этому заказу. Экран владельца, поэтому показываем и то,
  // чего клиент никогда не увидит: запрос к модели и её сырой ответ. Сбой не должен ронять
  // карточку заказа — ассистент здесь гость.
  const assistantTurns: AssistantTurn[] = await prisma.aiTurn
    .findMany({
      where: { orderId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, status: true, source: true, intent: true, important: true, needsHuman: true,
        replyText: true, skipReason: true, promptText: true, responseText: true, modelName: true,
        latencyMs: true, createdAt: true,
        communication: { select: { messageText: true, transcript: true } },
      },
    })
    .then((rows) =>
      rows.map((t) => ({
        id: t.id,
        status: t.status,
        source: t.source,
        intent: t.intent,
        important: t.important,
        needsHuman: t.needsHuman,
        replyText: t.replyText,
        skipReason: t.skipReason,
        promptText: t.promptText,
        responseText: t.responseText,
        modelName: t.modelName,
        latencyMs: t.latencyMs,
        createdAt: t.createdAt.toISOString(),
        incomingText: t.communication.messageText ?? t.communication.transcript ?? null,
      }))
    )
    .catch(() => []);
  // Сухой прогон читаем отдельным запросом: сериализованный заказ про ассистента ничего не
  // знает, а тащить поле через общую сериализацию ради одной плашки не стоит.
  const assistantDryRun = assistantTurns.length
    ? (await prisma.order
        .findUnique({ where: { id }, select: { site: { select: { aiDryRun: true } } } })
        .then((r) => r?.site?.aiDryRun ?? true)
        .catch(() => true))
    : true;

  return (
    <OrderPageShell
      backHref="/dashboard/orders"
      backLabel="Все заказы"
      orderNumber={order.orderNumber}
      siteName={order.site.name}
      badges={
        <>
          <OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />
          {showPayment && <PaymentStatusBadge status={order.paymentStatus} />}
          {/* Кто делает букет — вопрос того же порядка, что и статус, поэтому стоит рядом,
              а не в блоке назначения ниже по странице. Только у владельца: флорист и
              колл-центр назначение не видят (см. serializeForOwner). */}
          {order.currentFloristName && (
            <span className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-slate-700">
              <FloristAvatar name={order.currentFloristName} avatarUrl={order.currentFloristAvatarUrl} size={18} />
              {order.currentFloristName}
            </span>
          )}
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
      belowDelivery={
        <CustomerNoteBanner orderId={order.id} updatedAt={order.updatedAt} customerNote={order.customerNote} />
      }
      left={
        <>
          <OrderItemsCard
            items={order.items.map((it) => ({
              id: it.id,
              name: it.name,
              quantity: it.quantity,
              image: it.image,
              variantImage: it.variantImage,
              variantName: it.variantName,
              floristComposition: it.floristComposition,
              prices: [
                { value: it.externalPrice, label: "заказчику" },
                { value: it.floristItemPrice, label: "флористу", missing: it.floristPriceMissing },
              ],
              // Кнопка обновления состава тянет его ИЗ КАТАЛОГА — у позиции ручного
              // заказа «своим текстом» каталога нет, и жать там нечего.
              action: it.productId ? <UpdateCompositionButton itemId={it.id} /> : undefined,
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
              addressLines: senderAddressLines(order.senderAddress),
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

          {/* Раскладка счёта клиента. Прибыли здесь нет — см. комментарий к странице. */}
          <OrderFinanceBreakdown
            title="Раскладка заказа"
            finance={order.finance}
            action={
              // Только у заказов, заведённых руками: у платформенных суммы придут с синхронизацией
              // и затрут правку.
              order.source === "MANUAL" ? (
                <ChargesDialog
                  orderId={order.id}
                  itemsTotal={order.finance.itemsTotal}
                  current={{
                    tax: order.finance.tax,
                    tip: order.finance.tip,
                    discount: order.finance.discount,
                    deliveryCustomerCost: order.finance.deliveryCustomerCost,
                  }}
                />
              ) : null
            }
          />

          <CardNoteCard
            orderId={order.id}
            updatedAt={order.updatedAt}
            cardMessage={order.cardMessage}
            collapsible
          />

          {/* Общение (SMS/звонки) через QUO */}
          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={storeHasQuoNumber}
            emails={emailPanel.emails}
          customerEmail={emailPanel.customerEmail}
          communications={communications}
            storeTimeZone={storeTimeZone}
            unread={commUnread}
          />

          {/* Разборы ассистента: единственное место, где видно его работу во время сухого прогона. */}
          <OrderAssistantCard turns={assistantTurns} dryRun={assistantDryRun} />

          {/* Доставка целиком: курьер, Burq и точка забора. Раньше владелец имел собственную
              копию этого блока вместе с копией трёх запросов Burq — теперь блок один. */}
          <DeliveryStatusCard
            canEditActualCost
            orderId={order.id}
            orderStatus={order.orderStatus}
            deliveryInstructions={order.deliveryInstructions}
            trackingUrl={order.trackingUrl}
            bouquetPhotoUrl={order.bouquetPhotoUrl}
            bouquetPhotoAction={<BouquetPhotoButton orderId={order.id} photoUrl={order.bouquetPhotoUrl} />}
            deliveryPhotoUrl={order.deliveryPhotoUrl}
            storeTimeZone={storeTimeZone}
            pickup={<OrderPickupCard orderId={order.id} />}
            courierNote={

              <CourierNoteCard

                orderId={order.id}

                updatedAt={order.updatedAt}

                courierNote={order.courierNote}

                deliveryAlreadyCreated={order.deliveryStatus !== "PENDING"}

              />

            }
          />

          {/* ── Служебное. Держится ОТДЕЛЬНО, в самом низу: к работе с заказом эти два блока
                 отношения не имеют, и в потоке основных карточек только мешали. ── */}
          {order.airwallex && (
            <div className="space-y-2">
              <AirwallexPanel aw={order.airwallex} refund={refundSummary} orderId={order.id} />
              {/* Возврат живёт рядом с платежом, а не среди «быстрых действий»: он необратим
                  и не должен стоять в одном ряду с картой и переназначением флориста.
                  Доступность и суммы модалка спрашивает у Airwallex при открытии. */}
              <div className="flex justify-end">
                <RefundDialog orderId={order.id} orderNumber={order.orderNumber} />
              </div>
            </div>
          )}

          {/* Пустой истории быть не должно: карточка с заголовком и ничем внутри только
              занимает экран — у заказов без назначений её просто нет. */}
          {order.assignments.length > 0 && (
          <Card>
            <CardHeader className="py-2.5"><CardTitle>История назначений</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {order.assignments.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium break-words text-slate-700">{a.floristName}</span>
                      <span className="ml-2 text-xs text-slate-400">{stateLabel(a.state)} · {a.priceMode === "MANUAL" ? "ручная" : "авто"} {formatMoney(a.floristTotal)}</span>
                    </div>
                    <span className="ml-auto text-xs whitespace-nowrap text-slate-400">{fmtDateTime(a.assignedAt)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          )}
        </>
      }
      right={
        <>
          {/* Чем оплачивается заказ флористу — зависит от МОДЕЛИ его профиля на дату
              доставки. Правка ручной цены живёт карандашом на плашке и появляется только
              там, где цене есть что менять. */}
          {order.currentFloristId && (
            <OrderFloristPayCard
              pay={pay}
              priceAction={<OwnerPriceDialog orderId={order.id} current={order.finance.floristTotal} />}
            />
          )}

          {noFloristReason && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Флорист не назначен: {noFloristReason}. Назначить вручную можно в любом случае — недоступность
              останавливает только автоматический выбор.
            </div>
          )}

          <OrderStatusCard orderId={order.id} updatedAt={order.updatedAt} orderStatus={order.orderStatus} />

          <OrderQuickActions
            orderId={order.id}
            mapsUrl={recipientMapsUrl(order)}
            reassign={{
              florists: florists.map((f) => ({ id: f.id, name: f.user.name })),
              currentFloristId: order.currentFloristId,
              priceMode: order.priceMode,
            }}
            expense={{ actions: { add: addOrderExpenseAction, update: updateOrderExpenseAction, remove: removeOrderExpenseAction } }}
          />

          <OrderExpensesSection orderId={order.id} hideWhenEmpty />

          {/* Редкая настройка — внизу колонки и свёрнутая. */}
          <MarketingMarkCard orderId={order.id} mark={order.marketingMark} />
        </>
      }
    />
  );
}

/**
 * Модель оплаты заказа для плашки в колонке управления.
 *
 * SECONDARY — фиксированная цена заказа и есть заработок (`balance.ts::secondaryEarned`
 * складывает именно `Order.floristTotal`). PRIMARY — доля от прибыли ДНЯ, и сумма по
 * отдельному заказу не существует: `floristTotal` не входит ни в заработок, ни в прибыль
 * дня. Профиля нет — заказ вообще ни во что не считается, и это надо сказать вслух.
 */
async function resolveFloristPay(
  floristId: string | null,
  deliveryDate: Date | string,
  price: { floristTotal: number; priceMode: "AUTO" | "MANUAL" }
): Promise<FloristPayView> {
  if (!floristId) return { model: null };
  // Профиль читается вне основного пути карточки: недоступность финансовых таблиц не должна
  // ронять страницу заказа — тогда просто не покажем плашку оплаты.
  const profile = await resolveProfileAt(floristId, new Date(deliveryDate)).catch(() => null);
  if (!profile) return { model: null };
  return profile.model === "PRIMARY"
    ? { model: "PRIMARY", sharePercentBp: profile.sharePercentBp }
    : { model: "SECONDARY", floristTotal: price.floristTotal, priceMode: price.priceMode };
}

function stateLabel(state: string): string {
  const map: Record<string, string> = { ASSIGNED: "назначен", ACCEPTED: "принял", DECLINED: "отказался", REASSIGNED: "переназначен" };
  return map[state] ?? state;
}
