import "server-only";
/**
 * Единая точка планирования доставки после сохранения заказа. Вызывается из ingest-путей
 * (Shopify/Woo) ОДНИМ вызовом. Идемпотентна: DeliveryIntent — upsert, outbox-задача —
 * дедуп по ключу `burq:draft:create:{orderId}:v{scheduleVersion}`.
 *
 * Планирование НЕ зависит от BURQ_ENABLED и от готовности флориста/pickup: задача ставится
 * всегда, а worker при исполнении повторно решает eligibility (site_disabled/no_florist/...).
 * Ошибки планирования НЕ должны ломать импорт заказа — вызывающий оборачивает в try/catch.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { scheduleBurqDraftForOrder } from "./schedule";
import { handleFloristReassignment } from "./reassignmentService";

async function enqueueDraftTask(prisma: PrismaClient, orderId: string, scheduleVersion: number): Promise<Date | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { deliveryDate: true, site: { select: { timezone: true, burqDraftCreationLocalTime: true } } },
  });
  if (!order) return null;
  const repo = new PrismaOutboxRepository(prisma);
  const { availableAt } = await scheduleBurqDraftForOrder(
    { enqueue: (input) => repo.enqueue(input).then((r) => ({ created: r.created })) },
    {
      orderId,
      deliveryDate: order.deliveryDate,
      timezone: order.site?.timezone,
      creationLocalTime: order.site?.burqDraftCreationLocalTime ?? "04:00",
      scheduleVersion,
    }
  );
  await prisma.deliveryIntent.update({ where: { orderId }, data: { scheduledAvailableAt: availableAt } });
  return availableAt;
}

/** Первичное планирование после сохранения заказа (scheduleVersion=0). Идемпотентно. */
export async function scheduleDeliveryForNewOrder(prisma: PrismaClient, orderId: string): Promise<{ scheduled: boolean; availableAt: Date | null }> {
  if (!isBurqRuntimeEnabled()) return { scheduled: false, availableAt: null }; // master gate: полный no-op
  const exists = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) return { scheduled: false, availableAt: null };

  const intent = await prisma.deliveryIntent.upsert({
    where: { orderId },
    create: { orderId, intentStatus: "SCHEDULED" },
    update: {},
    select: { scheduleVersion: true },
  });
  const availableAt = await enqueueDraftTask(prisma, orderId, intent.scheduleVersion);
  return { scheduled: true, availableAt };
}

/**
 * Перепланирование при изменении входных данных доставки (без активного draft): бумпит
 * scheduleVersion (инвалидирует устаревшие pending-задачи) и ставит новую задачу с пересчитанным
 * availableAt (same-day → now, будущее → 04:00 локального дня доставки).
 */
export async function rescheduleDeliveryForOrder(prisma: PrismaClient, orderId: string): Promise<{ availableAt: Date | null }> {
  if (!isBurqRuntimeEnabled()) return { availableAt: null }; // master gate
  const intent = await prisma.deliveryIntent.upsert({
    where: { orderId },
    create: { orderId, intentStatus: "SCHEDULED" },
    update: { scheduleVersion: { increment: 1 }, intentStatus: "SCHEDULED", lastSkipReason: null },
    select: { scheduleVersion: true },
  });
  const availableAt = await enqueueDraftTask(prisma, orderId, intent.scheduleVersion);
  return { availableAt };
}

/**
 * ЕДИНАЯ точка реакции на изменение входных данных доставки (флорист/дата/адрес/телефон/pickup).
 * Если активный Burq draft уже создан — DELETE-неинициированного-или-флаг + новая attempt со
 * свежими данными (handleFloristReassignment). Если draft ещё нет — (пере)планирование задачи.
 * Терминальные заказы пропускаются.
 */
export async function onOrderDeliveryChange(prisma: PrismaClient, orderId: string): Promise<void> {
  if (!isBurqRuntimeEnabled()) return; // master gate: hooks назначения/даты/адреса/pickup — no-op
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderStatus: true } });
  if (!order || TERMINAL_ORDER_STATUSES.includes(order.orderStatus)) return;

  const currentDraft = await prisma.delivery.findFirst({
    where: { orderId, isCurrentAttempt: true, externalDeliveryId: { not: null } },
    select: { id: true },
  });
  if (currentDraft) {
    await handleFloristReassignment(prisma, orderId, "INPUTS_CHANGED");
  } else {
    await rescheduleDeliveryForOrder(prisma, orderId);
  }
}

/** Не бросающая обёртка для вызова из server actions/сервисов — ошибка логируется, не ломает UX. */
export async function onOrderDeliveryChangeSafe(prisma: PrismaClient, orderId: string): Promise<void> {
  try {
    await onOrderDeliveryChange(prisma, orderId);
  } catch (err) {
    console.error(`[burq] reschedule failed for order ${orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Перепланирование заказов, назначенных на флориста и ждущих его pickup (WAITING_FOR_FLORIST)
 * либо без активного draft. Вызывается после настройки/активации pickup-локации флориста.
 */
export async function rescheduleFloristWaitingOrders(prisma: PrismaClient, floristId: string, now: Date = new Date()): Promise<number> {
  if (!isBurqRuntimeEnabled()) return 0; // master gate
  const orders = await prisma.order.findMany({
    where: {
      currentFloristId: floristId,
      deliveryDate: { gte: startOfUtcDay(now) },
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
      deliveries: { none: { isCurrentAttempt: true, externalDeliveryId: { not: null } } },
    },
    select: { id: true },
  });
  for (const o of orders) await rescheduleDeliveryForOrder(prisma, o.id);
  return orders.length;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Массовое перепланирование будущих заказов сайта без активного draft (напр. при смене
 * Site.timezone: availableAt считался по старой зоне). Возвращает число перепланированных.
 */
export async function rescheduleSiteFutureOrders(prisma: PrismaClient, siteId: string, now: Date = new Date()): Promise<number> {
  if (!isBurqRuntimeEnabled()) return 0; // master gate
  const orders = await prisma.order.findMany({
    where: {
      siteId,
      deliveryDate: { gte: now },
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
      deliveries: { none: { isCurrentAttempt: true, externalDeliveryId: { not: null } } },
    },
    select: { id: true },
  });
  for (const o of orders) await rescheduleDeliveryForOrder(prisma, o.id);
  return orders.length;
}
