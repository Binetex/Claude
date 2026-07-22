import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForOwner } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge, PaymentStatusBadge, AssignmentStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
import { OrderItemImages } from "@/components/OrderItemImages";
import { Separator } from "@/components/ui/misc";
import { formatMoney } from "@/lib/money";
import { fmtDate, fmtDateTime, formatOrderNumber } from "@/lib/format";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { UpdateCompositionButton } from "../UpdateCompositionButton";
import { OwnerOrderControls } from "./OwnerOrderControls";
import { ContactEditDialog } from "./ContactEditDialog";
import { CardNoteCard } from "./CardNoteCard";
import { BurqDeliveryPanel } from "./BurqDeliveryPanel";
import { OrderCommunications, type CommItem } from "./OrderCommunications";
import { markOrderCommunicationsRead, countUnreadBySide, parseAttachments } from "@/integrations/quo/communicationsService";

export const dynamic = "force-dynamic";

export default async function OwnerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForOwner(id);
  if (!order) notFound();

  const florists = await prisma.florist.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } });
  const showAssignment = !(TERMINAL_ORDER_STATUSES as string[]).includes(order.orderStatus);

  // QUO: история коммуникаций + номер магазина. Обёрнуто в try/catch — временная недоступность
  // не должна ронять карточку заказа (историю читаем из локальной БД, не из QUO).
  let communications: CommItem[] = [];
  let storeHasQuoNumber = false;
  let storeTimeZone: string | undefined;
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
        select: { id: true, type: true, direction: true, status: true, partyRole: true, externalPhone: true, messageText: true, durationSeconds: true, recordingUrl: true, transcript: true, summary: true, attachmentsJson: true, occurredAt: true, sentByUserId: true },
      }),
      prisma.site.findFirst({ where: { orders: { some: { id } } }, select: { quoPhoneNumberId: true, quoEnabled: true, timezone: true } }),
    ]);
    const senderIds = [...new Set(comms.map((c) => c.sentByUserId).filter((x): x is string => !!x))];
    const users = senderIds.length ? await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, name: true } }) : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    communications = comms.map((c) => ({
      id: c.id, type: c.type, direction: c.direction, status: c.status, partyRole: c.partyRole,
      externalPhone: c.externalPhone, messageText: c.messageText, durationSeconds: c.durationSeconds,
      recordingUrl: c.recordingUrl, transcript: c.transcript, summary: c.summary,
      attachments: parseAttachments(c.attachmentsJson),
      occurredAt: c.occurredAt.toISOString(), sentByName: c.sentByUserId ? nameById.get(c.sentByUserId) ?? null : null,
    }));
    storeHasQuoNumber = !!(siteQuo?.quoPhoneNumberId && siteQuo?.quoEnabled);
    storeTimeZone = siteQuo?.timezone ?? undefined;
  } catch {
    // QUO-таблицы недоступны — блок общения просто не покажет историю.
  }

  // Адрес отправителя (billing) несколькими аккуратными строками. Пусто → блок покажет «не указан».
  const sa = order.senderAddress;
  const senderAddressLines = [
    [sa.addressLine, sa.apartment].filter(Boolean).join(", "),
    [sa.city, sa.province, sa.zip].filter(Boolean).join(" "),
    sa.country,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  // Текущая попытка доставки Burq + интент + окружение Burq (для панели доставки). Обёрнуто в
  // try/catch: даже если таблицы/БД временно недоступны, карточка заказа не должна падать (500).
  let currentDelivery = null;
  let deliveryIntent = null;
  let deliveryAttempts: import("./BurqDeliveryPanel").DeliveryAttempt[] = [];
  try {
    const [d, i, all] = await Promise.all([
      prisma.delivery.findFirst({
        where: { orderId: id, isCurrentAttempt: true },
        select: {
          id: true, status: true, rawProviderStatus: true, attemptNumber: true, externalDeliveryId: true,
          finalCost: true, currency: true, providerName: true, finalCostUpdatedAt: true,
          courierName: true, courierPhone: true, trackingUrl: true,
          proofOfDeliveryUrls: true, signatureImageUrl: true, deliveredAt: true,
          // История статусов — чтобы показать «Курьер вызван» (первый активный статус курьера) и «Доставка завершена».
          statusEvents: { select: { normalizedStatus: true, occurredAt: true, receivedAt: true }, orderBy: { receivedAt: "asc" } },
        },
      }),
      prisma.deliveryIntent.findUnique({
        where: { orderId: id },
        select: { intentStatus: true, lastSkipReason: true, scheduledAvailableAt: true },
      }),
      prisma.delivery.findMany({
        where: { orderId: id },
        orderBy: { attemptNumber: "asc" },
        select: {
          attemptNumber: true, status: true, createdAt: true, cancelledAt: true, deliveredAt: true,
          finalCost: true, currency: true, externalDeliveryId: true, cancellationReason: true,
          proofOfDeliveryUrls: true,
          florist: { select: { user: { select: { name: true } } } },
        },
      }),
    ]);
    currentDelivery = d;
    deliveryIntent = i;
    deliveryAttempts = all.map((a) => ({
      attemptNumber: a.attemptNumber,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      cancelledAt: a.cancelledAt ? a.cancelledAt.toISOString() : null,
      deliveredAt: a.deliveredAt ? a.deliveredAt.toISOString() : null,
      finalCost: a.finalCost != null ? Number(a.finalCost) : null,
      currency: a.currency,
      externalDeliveryId: a.externalDeliveryId,
      floristName: a.florist?.user.name ?? null,
      cancellationReason: a.cancellationReason,
      podPresent: Array.isArray(a.proofOfDeliveryUrls) && (a.proofOfDeliveryUrls as unknown[]).length > 0,
    }));
  } catch {
    // Burq-таблицы недоступны — панель доставки просто не покажет данные.
  }

  // «Курьер вызван» = первый статус, где курьер уже задействован; «Доставка завершена» = deliveredAt / статус DELIVERED.
  const COURIER_ACTIVE = new Set(["COURIER_ASSIGNED", "COURIER_EN_ROUTE_TO_PICKUP", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT"]);
  const evts = currentDelivery?.statusEvents ?? [];
  const startedEvt = evts.find((e) => COURIER_ACTIVE.has(e.normalizedStatus));
  const deliveredEvt = evts.find((e) => e.normalizedStatus === "DELIVERED");
  const courierCalledAt: Date | null = startedEvt ? (startedEvt.occurredAt ?? startedEvt.receivedAt) : null;
  const deliveryCompletedAt: Date | null = deliveredEvt ? (deliveredEvt.occurredAt ?? deliveredEvt.receivedAt) : (currentDelivery?.deliveredAt ?? null);

  return (
    <div className="space-y-4">
      <Link href="/dashboard/orders" className="text-sm text-slate-500 hover:underline">← Все заказы</Link>

      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold text-slate-900">{formatOrderNumber(order.orderNumber)}</h1>
        <span className="text-sm text-slate-500">{order.site.name}</span>
        <div className="flex flex-wrap gap-1.5">
          <OrderStatusBadge status={order.orderStatus} paymentFailed={order.paymentFailed} />
          <PaymentStatusBadge status={order.paymentStatus} />
          {showAssignment && <AssignmentStatusBadge status={order.assignmentStatus} />}
        </div>
      </div>

      {/* Доставка — крупно */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
        <span className="text-xs tracking-wide text-slate-400 uppercase">Доставка</span>
        <span className="text-base font-semibold text-slate-900">{fmtDate(order.deliveryDate)}</span>
        {order.deliveryWindow && <span className="text-base font-bold text-slate-900">{order.deliveryWindow}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Левая колонка — данные */}
        <div className="space-y-4 lg:col-span-2">
          {/* Открытка и заметка — важное, наверху */}
          <CardNoteCard orderId={order.id} updatedAt={order.updatedAt} cardMessage={order.cardMessage} customerNote={order.customerNote} />

          {/* Товары */}
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
                      <UpdateCompositionButton itemId={it.id} />
                    </div>
                    <div className="text-right text-sm whitespace-nowrap">
                      <div className="text-slate-700">{formatMoney(it.externalPrice)} <span className="text-xs text-slate-400">заказчику</span></div>
                      <div className="text-slate-500">{formatMoney(it.floristItemPrice)} <span className="text-xs text-slate-400">флористу</span></div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* Отправитель / Получатель с редактированием из карточки */}
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
              <CardBody className="space-y-0.5 text-sm">
                <div className="font-medium text-slate-800">{order.senderName}</div>
                <div className="text-slate-600">{order.senderPhone || "—"}</div>
                <div className="text-slate-500">{order.senderEmail ?? "—"}</div>
                <div className="pt-1 text-slate-600">
                  {senderAddressLines.length > 0 ? (
                    senderAddressLines.map((l, i) => <div key={i}>{l}</div>)
                  ) : (
                    <span className="text-slate-400">Адрес отправителя не указан</span>
                  )}
                </div>
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
              <CardBody className="space-y-0.5 text-sm">
                <div className="font-medium text-slate-800">{order.recipientName}</div>
                <div className="text-slate-600">{order.recipientPhone || "—"}</div>
                <div className="text-slate-500">{order.recipientEmail ?? "—"}</div>
                <div className="pt-1 text-slate-600">
                  {order.addressLine}{order.apartment ? `, ${order.apartment}` : ""}, {order.city} {order.zip}
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Финансы — ключевые цифры крупно, разбивка ниже */}
          <Card>
            <CardHeader><CardTitle>Финансы</CardTitle></CardHeader>
            <CardBody>
              <div className="grid grid-cols-3 gap-3">
                <BigFig label="Итого заказчик" value={formatMoney(order.finance.customerTotal)} />
                <BigFig label="Флористу" value={formatMoney(order.finance.floristTotal)} />
                <BigFig label="≈ Прибыль" value={formatMoney(order.finance.estimatedProfit)} tone="text-blue-600" />
              </div>
              <Separator className="my-3" />
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
                <FinRow label="Сумма товаров" value={formatMoney(order.finance.itemsTotal)} />
                <FinRow label="Налог" value={formatMoney(order.finance.tax)} />
                <FinRow label="Чаевые" value={formatMoney(order.finance.tip)} />
                <FinRow label="Скидка" value={formatMoney(order.finance.discount)} />
                <FinRow label="Доставка (заказчик)" value={formatMoney(order.finance.deliveryCustomerCost)} />
                <FinRow label="Доставка (факт)" value={formatMoney(order.finance.deliveryActualCost)} />
              </div>
            </CardBody>
          </Card>

          {/* Доставка — единый блок: статус заказа + инструкции доставки + вся плашка Burq. */}
          <Card>
            <CardHeader><CardTitle>Статус доставки</CardTitle></CardHeader>
            <CardBody className="space-y-3 text-sm">
              {order.deliveryInstructions?.trim() && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
                  <div className="text-xs font-semibold text-amber-800">Инструкции доставки</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-slate-800">{order.deliveryInstructions}</div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Info label="Курьер вызван" value={fmtLocalDateTime(courierCalledAt, storeTimeZone)} />
                <Info label="Доставка завершена" value={fmtLocalDateTime(deliveryCompletedAt, storeTimeZone)} />
                <Info label="Tracking" value={order.trackingUrl ? <a href={order.trackingUrl} className="text-sky-600 underline" target="_blank" rel="noreferrer">Открыть</a> : "—"} />
                {order.bouquetPhotoUrl && (
                  <div><div className="mb-1 text-xs text-slate-400">Фото букета</div><ZoomableImage src={order.bouquetPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
                )}
                {order.deliveryPhotoUrl && (
                  <div><div className="mb-1 text-xs text-slate-400">Фото доставки</div><ZoomableImage src={order.deliveryPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
                )}
              </div>

              {/* Плашка Burq перенесена сюда целиком (единый блок доставки). */}
              <BurqDeliveryPanel
                orderId={order.id}
                orderStatus={order.orderStatus}
                attempts={deliveryAttempts}
                delivery={
                  currentDelivery
                    ? {
                        id: currentDelivery.id,
                        status: currentDelivery.status,
                        rawProviderStatus: currentDelivery.rawProviderStatus,
                        attemptNumber: currentDelivery.attemptNumber,
                        externalDeliveryId: currentDelivery.externalDeliveryId,
                        finalCost: currentDelivery.finalCost != null ? Number(currentDelivery.finalCost) : null,
                        currency: currentDelivery.currency,
                        providerName: currentDelivery.providerName,
                        finalCostUpdatedAt: currentDelivery.finalCostUpdatedAt ? currentDelivery.finalCostUpdatedAt.toISOString() : null,
                        courierName: currentDelivery.courierName,
                        courierPhone: currentDelivery.courierPhone,
                        proofOfDeliveryUrls: Array.isArray(currentDelivery.proofOfDeliveryUrls) ? (currentDelivery.proofOfDeliveryUrls as string[]) : [],
                        signatureImageUrl: currentDelivery.signatureImageUrl,
                      }
                    : null
                }
                intent={
                  deliveryIntent
                    ? {
                        intentStatus: deliveryIntent.intentStatus,
                        lastSkipReason: deliveryIntent.lastSkipReason,
                        scheduledAvailableAt: deliveryIntent.scheduledAvailableAt ? deliveryIntent.scheduledAvailableAt.toISOString() : null,
                      }
                    : null
                }
              />
            </CardBody>
          </Card>

          {/* Общение (SMS/звонки) через QUO */}
          <OrderCommunications
            orderId={order.id}
            customerPhone={order.senderPhone}
            recipientPhone={order.recipientPhone}
            storeHasQuoNumber={storeHasQuoNumber}
            communications={communications}
            storeTimeZone={storeTimeZone}
            unread={commUnread}
          />

          {/* Легаси-блок «История сообщений» (модель Message) удалён: он никогда не наполнялся и
              вводил в заблуждение. Полная переписка теперь в блоке «Общение (SMS)» выше (QUO). */}

          {/* История назначений */}
          <Card>
            <CardHeader><CardTitle>История назначений</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {order.assignments.map((a, i) => (
                  <li key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                    <div>
                      <span className="font-medium text-slate-700">{a.floristName}</span>
                      <span className="ml-2 text-xs text-slate-400">{stateLabel(a.state)} · {a.priceMode === "MANUAL" ? "ручная" : "авто"} {formatMoney(a.floristTotal)}</span>
                    </div>
                    <span className="text-xs text-slate-400">{fmtDateTime(a.assignedAt)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        {/* Правая колонка — управление */}
        <div className="lg:col-span-1">
          <div className="sticky top-16">
            <OwnerOrderControls
              orderId={order.id}
              updatedAt={order.updatedAt}
              order={{
                orderStatus: order.orderStatus,
                deliveryDate: format(new Date(order.deliveryDate), "yyyy-MM-dd"),
                deliveryWindow: order.deliveryWindow,
                priceMode: order.priceMode,
                floristTotal: order.finance.floristTotal,
                currentFloristId: order.currentFloristId,
              }}
              florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Дата/время в местном (для магазина) часовом поясе. "—" если нет значения. */
function fmtLocalDateTime(d: Date | string | null | undefined, timeZone?: string): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(d));
  } catch {
    return new Date(d).toLocaleString("ru-RU");
  }
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-slate-700">{value}</div>
    </div>
  );
}

function BigFig({ label, value, tone = "text-slate-900" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function FinRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-700">{value}</span>
    </div>
  );
}

function stateLabel(state: string): string {
  const map: Record<string, string> = { ASSIGNED: "назначен", ACCEPTED: "принял", DECLINED: "отказался", REASSIGNED: "переназначен" };
  return map[state] ?? state;
}
