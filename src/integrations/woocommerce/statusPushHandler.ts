import "server-only";
/**
 * Outbox-обработчик записи статуса в WooCommerce.
 *
 * Все проверки делаются ЗДЕСЬ, а не при постановке задачи: между постановкой и выполнением
 * заказ мог измениться (магазин сам перевёл его в processing, владелец выключил галочку,
 * заказ отменили). Решение принимается по свежему состоянию.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { resolveWooCredentials } from "./credentials";
import { isPushableWooStatus, pushWooOrderPaid } from "./statusPush";
import type { WooStatusPushPayload } from "./statusPushEvents";

export function buildWooStatusPushHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as WooStatusPushPayload;
    if (!p?.orderId) return;

    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: { id: true, siteId: true, externalId: true, externalStatus: true, platform: true, orderNumber: true },
    });
    if (!order || order.platform !== "WOOCOMMERCE" || !order.externalId) return;

    // Выключатель магазина проверяем в момент записи: снятая галочка должна останавливать
    // уже стоящие в очереди задачи, иначе «выключить» не означало бы «прекратить писать».
    const conn = await prisma.wooCommerceConnection.findUnique({
      where: { siteId: order.siteId },
      select: { pushPaidStatusToWoo: true },
    });
    if (!conn?.pushPaidStatusToWoo) return;

    // Статус мог уйти вперёд сам (плагин дожал платёж) или в терминальное состояние —
    // тогда писать нечего и не во что.
    if (!isPushableWooStatus(order.externalStatus)) return;

    const creds = await resolveWooCredentials(order.siteId);
    await pushWooOrderPaid(creds, order.externalId);
    console.info(`[woo] ${order.orderNumber}: статус в магазине переведён в processing (Airwallex подтвердил оплату)`);
    // Обратно ничего не пишем: Woo отдаст order.updated, и обычный приём переведёт заказ
    // в PAID/CONFIRMED со всеми последствиями (флорист, Burq, триггеры).
  };
}
