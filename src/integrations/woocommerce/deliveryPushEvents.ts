import "server-only";
/**
 * Постановка «записать перенос доставки в Woo» в outbox и её обработчик.
 *
 * Через очередь: WordPress бывает медленным и падучим, а перенос в карточке или ответ
 * ассистента не должны ни ждать его, ни ломаться. Обработчик берёт СВЕЖИЕ дату и окно из
 * заказа, а не из payload: если перенесли дважды подряд, в магазин уйдёт последнее.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { resolveWooCredentials } from "./credentials";
import { pushWooDelivery, PI_WINDOW_META } from "./deliveryPush";
import { windowOf } from "@/lib/deliveryWindow";

export const WOO_DELIVERY_PUSH_EVENT = "woo.delivery.push";

export type WooDeliveryPushPayload = { orderId: string };

/**
 * Ключ — заказ плюс момент его последнего изменения (`updatedAt`): каждый перенос даёт свою
 * задачу, а двойной вызов по ОДНОЙ правке второй не создаёт. Ключ по «дню + окну» терял
 * возврат к прежнему значению: туда → обратно → снова туда давало ключ, который уже был, и
 * магазин оставался на промежуточном дне.
 */
export async function publishWooDeliveryPush(prisma: PrismaClient, orderId: string): Promise<void> {
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { updatedAt: true } });
    if (!o) return;
    await new PrismaOutboxRepository(prisma).enqueue({
      eventType: WOO_DELIVERY_PUSH_EVENT,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { orderId } satisfies WooDeliveryPushPayload,
      idempotencyKey: `woo:delivery:${orderId}:${o.updatedAt.toISOString()}`,
    });
  } catch (err) {
    console.error(`[woo] перенос доставки ${orderId} не поставлен в очередь:`, err instanceof Error ? err.message : String(err));
  }
}

export function buildWooDeliveryPushHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as WooDeliveryPushPayload;
    if (!p?.orderId) return;
    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: { siteId: true, platform: true, externalId: true, orderNumber: true, deliveryDate: true, deliveryWindow: true, windowFrom: true, windowTo: true },
    });
    if (!order || order.platform !== "WOOCOMMERCE" || !order.externalId) return;

    // Пишем только туда, где стоит плагин доставки: его ключ окна задан в маппинге магазина.
    const conn = await prisma.wooCommerceConnection.findUnique({ where: { siteId: order.siteId }, select: { orderMetaMapping: true } });
    const mapping = (conn?.orderMetaMapping ?? {}) as Record<string, unknown>;
    if (mapping.deliveryWindow !== PI_WINDOW_META) return;

    const day = order.deliveryDate.toISOString().slice(0, 10);
    const creds = await resolveWooCredentials(order.siteId);
    const res = await pushWooDelivery(creds, order.externalId, day, windowOf(order));
    console.info(
      res.slot
        ? `[woo] ${order.orderNumber}: перенос записан в магазин — ${day} ${res.slot}`
        : `[woo] ${order.orderNumber}: в магазин записана дата ${day}; окно «${order.deliveryWindow}» к слоту плагина не приводится, слот не тронут`
    );
  };
}
