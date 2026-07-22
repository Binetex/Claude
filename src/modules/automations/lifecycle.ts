import "server-only";
/**
 * Публикация trigger-событий авто-SMS из точек жизненного цикла заказа. Best-effort и
 * ИДЕМПОТЕНТНО: сбой публикации логируется, но НЕ ломает приём заказа/обновление доставки
 * (сам факт события — в durable outbox, дедуп по ключу). Вызывать ТОЛЬКО из «живых» путей:
 *  - ORDER_CREATED — строго после успешного ПЕРВОГО создания Order (не update/resync/backfill);
 *  - TRACKING_LINK_AVAILABLE — когда у заказа ВПЕРВЫЕ появился tracking-URL.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationTrigger } from "./events";
import { computeDailyTriggerAt, deliveryLocalDay } from "./dailySchedule";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";

export async function publishOrderCreatedTrigger(prisma: PrismaClient, args: { orderId: string; siteId: string }): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: "ORDER_CREATED",
      occurrenceKey: args.orderId, // один заказ создаётся один раз
    });
  } catch (err) {
    console.error(`[sms] publishOrderCreatedTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function publishOrderDeliveredTrigger(prisma: PrismaClient, args: { orderId: string; deliveryId: string }): Promise<void> {
  try {
    const ord = await prisma.order.findUnique({ where: { id: args.orderId }, select: { siteId: true } });
    if (!ord) return;
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: ord.siteId,
      triggerType: "ORDER_DELIVERED",
      occurrenceKey: args.deliveryId, // одна доставленная попытка → один триггер
    });
  } catch (err) {
    console.error(`[sms] publishOrderDeliveredTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function publishTrackingAvailableTrigger(
  prisma: PrismaClient,
  args: { orderId: string; siteId: string; deliveryId: string }
): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: "TRACKING_LINK_AVAILABLE",
      occurrenceKey: args.deliveryId, // одна попытка доставки → один tracking-триггер
    });
  } catch (err) {
    console.error(`[sms] publishTrackingAvailableTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Планирует триггер «Доставка сегодня» — отложенный факт на `Site.automationDailyLocalTime`
 * (по умолчанию 09:00) ЛОКАЛЬНОГО дня доставки. Отдельного планировщика не нужно: опрос
 * outbox-воркера и есть расписание (тот же приём, что у Burq-черновиков).
 *
 * Идемпотентность — по паре (заказ, локальный день доставки): повторные вызовы при resync и
 * переносах даты не создают дублей, а устаревшая задача при срабатывании отсеивается проверкой
 * «дата доставки всё ещё сегодня» в trigger-обработчике.
 *
 * Если рассчитанный момент уже прошёл (заказ на сегодня создан позже 9:00) — событие
 * становится доступным сразу: рассылка не теряется.
 */
export async function scheduleDeliveryTodayTrigger(prisma: PrismaClient, orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        siteId: true,
        deliveryDate: true,
        orderStatus: true,
        site: { select: { timezone: true, automationDailyLocalTime: true } },
      },
    });
    if (!order?.deliveryDate) return;
    if (TERMINAL_ORDER_STATUSES.includes(order.orderStatus as (typeof TERMINAL_ORDER_STATUSES)[number])) return;

    // Order.deliveryDate — UTC-полночь ЛОКАЛЬНОГО дня доставки, поэтому локальный день это
    // его UTC-календарная дата (пере-конвертация через tz сдвинула бы день).
    const localDay = deliveryLocalDay(order.deliveryDate);
    const availableAt = computeDailyTriggerAt(localDay, order.site?.automationDailyLocalTime, order.site?.timezone);

    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(
      repo,
      { orderId, siteId: order.siteId, triggerType: "DELIVERY_TODAY", occurrenceKey: `${orderId}:${localDay}` },
      availableAt
    );
  } catch (err) {
    console.error(`[sms] scheduleDeliveryTodayTrigger failed for order ${orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Триггеры состояния оплаты (PAYMENT_PENDING / PAYMENT_FAILED / ORDER_REFUNDED).
 * Публикуются на ПЕРЕХОДЕ в состояние, а не на каждом resync: occurrenceKey включает
 * само состояние, поэтому повторный ingest с тем же состоянием дубля не создаёт.
 */
export async function publishPaymentStateTrigger(
  prisma: PrismaClient,
  args: { orderId: string; siteId: string; triggerType: "PAYMENT_PENDING" | "PAYMENT_FAILED" | "ORDER_REFUNDED" }
): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: args.triggerType,
      occurrenceKey: `${args.orderId}:${args.triggerType}`,
    });
  } catch (err) {
    console.error(`[sms] publishPaymentStateTrigger(${args.triggerType}) failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}
