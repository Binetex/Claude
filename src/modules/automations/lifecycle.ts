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
import { publishAutomationTrigger, automationTriggerKey } from "./events";
import { computeDailyTriggerAt, deliveryLocalDay } from "./dailySchedule";
import { orderLifecycleTriggers, type OrderLifecycleSnapshot } from "./orderLifecycle";
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

/** occurrenceKey платформенного подтверждения доставки (Shopify fulfilled / Woo completed). */
const platformDeliveredOccurrenceKey = (orderId: string) => `${orderId}:ORDER_DELIVERED`;

/**
 * Публиковался ли уже ORDER_DELIVERED по этому заказу — ЛЮБЫМ из источников.
 *
 * Источников два и occurrenceKey у них разные (курьерский — по конкретной попытке доставки,
 * платформенный — по заказу), поэтому обычного дедупа outbox по ключу недостаточно: без этой
 * проверки заказ, доставленный курьером и следом отмеченный fulfilled в Shopify, получил бы
 * два «доставлено». Проверка идёт по УНИКАЛЬНОМУ индексу idempotencyKey (не скан JSON) и
 * перебирает ровно те ключи, которые вообще могли быть созданы для этого заказа.
 */
async function deliveredTriggerAlreadyPublished(prisma: PrismaClient, orderId: string): Promise<boolean> {
  const deliveries = await prisma.delivery.findMany({ where: { orderId }, select: { id: true } });
  const keys = [
    automationTriggerKey("ORDER_DELIVERED", platformDeliveredOccurrenceKey(orderId)),
    ...deliveries.map((d) => automationTriggerKey("ORDER_DELIVERED", d.id)),
  ];
  const found = await prisma.outboxEvent.count({ where: { idempotencyKey: { in: keys } } });
  return found > 0;
}

/** Подтверждение доставки курьером/владельцем (Burq webhook, ручное «отметить доставленным»). */
export async function publishOrderDeliveredTrigger(prisma: PrismaClient, args: { orderId: string; deliveryId: string }): Promise<void> {
  try {
    const ord = await prisma.order.findUnique({ where: { id: args.orderId }, select: { siteId: true } });
    if (!ord) return;
    // Заказ мог быть уже отмечен доставленным платформой — второй раз не шлём.
    if (await deliveredTriggerAlreadyPublished(prisma, args.orderId)) return;
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

/**
 * Подтверждение доставки самой платформой: Shopify `fulfillment_status=fulfilled`,
 * WooCommerce `completed`. Нужен потому, что курьерский путь (Burq) закрывает только заказы
 * с доставкой через Burq и вдобавок гейтится BURQ_RUNTIME_ENABLED — без этого публикатора
 * триггер «Заказ доставлен» на Shopify-магазинах не срабатывал бы вовсе.
 */
export async function publishPlatformOrderDeliveredTrigger(prisma: PrismaClient, args: { orderId: string; siteId: string }): Promise<void> {
  try {
    if (await deliveredTriggerAlreadyPublished(prisma, args.orderId)) return;
    const repo = new PrismaOutboxRepository(prisma);
    await publishAutomationTrigger(repo, {
      orderId: args.orderId,
      siteId: args.siteId,
      triggerType: "ORDER_DELIVERED",
      occurrenceKey: platformDeliveredOccurrenceKey(args.orderId),
    });
  } catch (err) {
    console.error(`[sms] publishPlatformOrderDeliveredTrigger failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
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

/**
 * Триггеры жизненного цикла заказа (ORDER_PAID / ORDER_DELIVERED / ORDER_CANCELLED) по
 * фактическому переходу состояния. Единая точка вызова для Shopify- и WooCommerce-ingest:
 * решение «был ли переход» принимает чистая orderLifecycleTriggers, здесь — только публикация.
 *
 * Вызывать ТОЛЬКО из «живых» путей приёма заказа (у Woo — под opts.emitLifecycle). Bulk-sync и
 * backfill истории проходить здесь не должны: там переходов нет, есть перенос уже случившегося.
 *
 * Best-effort: сбой публикации логируется и не ломает приём заказа (внутри каждого публикатора).
 */
export async function publishOrderLifecycleTriggers(
  prisma: PrismaClient,
  args: {
    orderId: string;
    siteId: string;
    /** Состояние ДО применения события; null — заказ создаётся прямо сейчас. */
    prev: OrderLifecycleSnapshot | null;
    /** Состояние ПОСЛЕ применения (уже с anti-rollback, т.е. то, что реально записано). */
    next: OrderLifecycleSnapshot;
  }
): Promise<void> {
  for (const triggerType of orderLifecycleTriggers(args.prev, args.next)) {
    if (triggerType === "ORDER_DELIVERED") {
      await publishPlatformOrderDeliveredTrigger(prisma, { orderId: args.orderId, siteId: args.siteId });
      continue;
    }
    try {
      const repo = new PrismaOutboxRepository(prisma);
      await publishAutomationTrigger(repo, {
        orderId: args.orderId,
        siteId: args.siteId,
        triggerType,
        occurrenceKey: `${args.orderId}:${triggerType}`, // состояние в ключе → повтор дубля не создаёт
      });
    } catch (err) {
      console.error(`[sms] publishOrderLifecycleTriggers(${triggerType}) failed for order ${args.orderId}:`, err instanceof Error ? err.message : String(err));
    }
  }
}
