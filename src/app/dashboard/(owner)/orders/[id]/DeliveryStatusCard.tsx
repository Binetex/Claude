import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { ZoomableImage } from "@/components/ImageLightbox";
import { BurqDeliveryPanel, type DeliveryAttempt } from "./BurqDeliveryPanel";
import type { OrderStatus } from "@/generated/prisma/enums";

/**
 * Единый блок «Статус доставки» (инструкции доставки + курьерские отметки + полная плашка Burq).
 * Server component: сам грузит данные попыток/интента Burq. Действия панели уже доступны любому
 * аутентифицированному сотруднику (requireUser), поэтому блок переиспользуется на страницах
 * колл-центра и флориста. Владелец использует собственную встроенную версию.
 */
export async function DeliveryStatusCard({
  orderId,
  orderStatus,
  deliveryInstructions,
  trackingUrl,
  bouquetPhotoUrl,
  deliveryPhotoUrl,
  storeTimeZone,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  deliveryInstructions: string | null;
  trackingUrl: string | null;
  bouquetPhotoUrl: string | null;
  deliveryPhotoUrl: string | null;
  storeTimeZone?: string;
}) {
  let currentDelivery = null;
  let deliveryIntent = null;
  let deliveryAttempts: DeliveryAttempt[] = [];
  try {
    const [d, i, all] = await Promise.all([
      prisma.delivery.findFirst({
        where: { orderId, isCurrentAttempt: true },
        select: {
          id: true, status: true, rawProviderStatus: true, attemptNumber: true, externalDeliveryId: true,
          finalCost: true, currency: true, providerName: true, finalCostUpdatedAt: true,
          courierName: true, courierPhone: true, trackingUrl: true,
          proofOfDeliveryUrls: true, signatureImageUrl: true, deliveredAt: true,
          statusEvents: { select: { normalizedStatus: true, occurredAt: true, receivedAt: true }, orderBy: { receivedAt: "asc" } },
        },
      }),
      prisma.deliveryIntent.findUnique({
        where: { orderId },
        select: { intentStatus: true, lastSkipReason: true, scheduledAvailableAt: true },
      }),
      prisma.delivery.findMany({
        where: { orderId },
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
    // Burq-таблицы недоступны — панель просто не покажет данные.
  }

  const COURIER_ACTIVE = new Set(["COURIER_ASSIGNED", "COURIER_EN_ROUTE_TO_PICKUP", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT"]);
  const evts = currentDelivery?.statusEvents ?? [];
  const startedEvt = evts.find((e) => COURIER_ACTIVE.has(e.normalizedStatus));
  const deliveredEvt = evts.find((e) => e.normalizedStatus === "DELIVERED");
  const courierCalledAt: Date | null = startedEvt ? (startedEvt.occurredAt ?? startedEvt.receivedAt) : null;
  const deliveryCompletedAt: Date | null = deliveredEvt ? (deliveredEvt.occurredAt ?? deliveredEvt.receivedAt) : (currentDelivery?.deliveredAt ?? null);

  return (
    <Card>
      <CardHeader><CardTitle>Статус доставки</CardTitle></CardHeader>
      <CardBody className="space-y-3 text-sm">
        {deliveryInstructions?.trim() && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
            <div className="text-xs font-semibold text-amber-800">Инструкции доставки</div>
            <div className="mt-0.5 whitespace-pre-wrap text-slate-800">{deliveryInstructions}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Info label="Курьер вызван" value={fmtLocalDateTime(courierCalledAt, storeTimeZone)} />
          <Info label="Доставка завершена" value={fmtLocalDateTime(deliveryCompletedAt, storeTimeZone)} />
          <Info label="Tracking" value={trackingUrl ? <a href={trackingUrl} className="text-sky-600 underline" target="_blank" rel="noreferrer">Открыть</a> : "—"} />
          {bouquetPhotoUrl && (
            <div><div className="mb-1 text-xs text-slate-400">Фото букета</div><ZoomableImage src={bouquetPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
          )}
          {deliveryPhotoUrl && (
            <div><div className="mb-1 text-xs text-slate-400">Фото доставки</div><ZoomableImage src={deliveryPhotoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" /></div>
          )}
        </div>

        <BurqDeliveryPanel
          orderId={orderId}
          orderStatus={orderStatus}
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
  );
}

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
