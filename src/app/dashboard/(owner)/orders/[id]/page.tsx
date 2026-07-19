import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { getForOwner } from "@/modules/orders/queries";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderStatusBadge, PaymentStatusBadge, AssignmentStatusBadge, DeliveryStatusBadge } from "@/components/StatusBadge";
import { ZoomableImage } from "@/components/ImageLightbox";
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

export const dynamic = "force-dynamic";

export default async function OwnerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getForOwner(id);
  if (!order) notFound();

  const florists = await prisma.florist.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } });
  const showAssignment = !(TERMINAL_ORDER_STATUSES as string[]).includes(order.orderStatus);

  // Текущая попытка доставки Burq + интент + окружение Burq (для панели доставки). Обёрнуто в
  // try/catch: даже если таблицы/БД временно недоступны, карточка заказа не должна падать (500).
  let currentDelivery = null;
  let deliveryIntent = null;
  let burqEnvironment: "SANDBOX" | "PRODUCTION" = "SANDBOX";
  let deliveryAttempts: import("./BurqDeliveryPanel").DeliveryAttempt[] = [];
  try {
    const [d, i, s, all] = await Promise.all([
      prisma.delivery.findFirst({
        where: { orderId: id, isCurrentAttempt: true },
        select: {
          id: true, status: true, attemptNumber: true, externalDeliveryId: true,
          finalCost: true, currency: true, providerName: true, finalCostUpdatedAt: true,
        },
      }),
      prisma.deliveryIntent.findUnique({
        where: { orderId: id },
        select: { intentStatus: true, lastSkipReason: true, scheduledAvailableAt: true },
      }),
      prisma.burqSettings.findUnique({ where: { id: "singleton" }, select: { environment: true } }),
      prisma.delivery.findMany({
        where: { orderId: id },
        orderBy: { attemptNumber: "asc" },
        select: {
          attemptNumber: true, status: true, createdAt: true, cancelledAt: true, deliveredAt: true,
          finalCost: true, currency: true, externalDeliveryId: true, cancellationReason: true,
          florist: { select: { user: { select: { name: true } } } },
        },
      }),
    ]);
    currentDelivery = d;
    deliveryIntent = i;
    burqEnvironment = (s?.environment as "SANDBOX" | "PRODUCTION") ?? "SANDBOX";
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
    }));
  } catch {
    // Burq-таблицы недоступны — панель доставки просто не покажет данные.
  }

  return (
    <div className="space-y-4">
      <Link href="/dashboard/orders" className="text-sm text-slate-500 hover:underline">← Все заказы</Link>

      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold text-slate-900">{formatOrderNumber(order.orderNumber)}</h1>
        <span className="text-sm text-slate-500">{order.site.name}</span>
        <div className="flex flex-wrap gap-1.5">
          <OrderStatusBadge status={order.orderStatus} />
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
          <CardNoteCard orderId={order.id} cardMessage={order.cardMessage} customerNote={order.customerNote} />

          {/* Товары */}
          <Card>
            <CardHeader><CardTitle>Товары</CardTitle></CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {order.items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-4 py-3">
                    {it.image && <ZoomableImage src={it.image} alt="" className="h-14 w-14 rounded-lg object-cover" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{it.name} × {it.quantity}</div>
                      <OrderItemComposition variantName={it.variantName} floristComposition={it.floristComposition} />
                      <UpdateCompositionButton itemId={it.id} />
                    </div>
                    <div className="text-right text-sm whitespace-nowrap">
                      <div className="text-slate-700">{formatMoney(it.externalPrice)} <span className="text-xs text-slate-400">клиенту</span></div>
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
                  initial={{ senderName: order.senderName, senderPhone: order.senderPhone, senderEmail: order.senderEmail ?? "" }}
                />
              </CardHeader>
              <CardBody className="space-y-0.5 text-sm">
                <div className="font-medium text-slate-800">{order.senderName}</div>
                <div className="text-slate-600">{order.senderPhone || "—"}</div>
                <div className="text-slate-500">{order.senderEmail ?? "—"}</div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Получатель</CardTitle>
                <ContactEditDialog
                  kind="recipient"
                  orderId={order.id}
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
                <BigFig label="Итого клиент" value={formatMoney(order.finance.customerTotal)} />
                <BigFig label="Флористу" value={formatMoney(order.finance.floristTotal)} />
                <BigFig label="≈ Прибыль" value={formatMoney(order.finance.estimatedProfit)} tone="text-blue-600" />
              </div>
              <Separator className="my-3" />
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
                <FinRow label="Сумма товаров" value={formatMoney(order.finance.itemsTotal)} />
                <FinRow label="Налог" value={formatMoney(order.finance.tax)} />
                <FinRow label="Чаевые" value={formatMoney(order.finance.tip)} />
                <FinRow label="Скидка" value={formatMoney(order.finance.discount)} />
                <FinRow label="Доставка (клиент)" value={formatMoney(order.finance.deliveryCustomerCost)} />
                <FinRow label="Доставка (факт)" value={formatMoney(order.finance.deliveryActualCost)} />
              </div>
            </CardBody>
          </Card>

          {/* Доставка — детали */}
          <Card>
            <CardHeader><CardTitle>Статус доставки</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <Info label="Статус" value={<DeliveryStatusBadge status={order.deliveryStatus} />} />
              <Info label="Tracking" value={order.trackingUrl ? <a href={order.trackingUrl} className="text-sky-600 underline" target="_blank" rel="noreferrer">Открыть</a> : "—"} />
              <Info label="Готовность" value={order.readyAt ? fmtDateTime(order.readyAt) : "—"} />
              {order.bouquetPhotoUrl && (
                <div><div className="mb-1 text-xs text-slate-400">Фото букета</div><ZoomableImage src={order.bouquetPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
              )}
              {order.deliveryPhotoUrl && (
                <div><div className="mb-1 text-xs text-slate-400">Фото доставки</div><ZoomableImage src={order.deliveryPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
              )}
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
            <div className="mt-4">
              <BurqDeliveryPanel
                orderId={order.id}
                recipientName={order.recipientName}
                environment={burqEnvironment}
                orderStatus={order.orderStatus}
                attempts={deliveryAttempts}
                delivery={
                  currentDelivery
                    ? {
                        id: currentDelivery.id,
                        status: currentDelivery.status,
                        attemptNumber: currentDelivery.attemptNumber,
                        externalDeliveryId: currentDelivery.externalDeliveryId,
                        finalCost: currentDelivery.finalCost != null ? Number(currentDelivery.finalCost) : null,
                        currency: currentDelivery.currency,
                        providerName: currentDelivery.providerName,
                        finalCostUpdatedAt: currentDelivery.finalCostUpdatedAt ? currentDelivery.finalCostUpdatedAt.toISOString() : null,
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
