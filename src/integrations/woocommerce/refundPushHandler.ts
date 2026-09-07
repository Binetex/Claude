import "server-only";
/**
 * Outbox-обработчик: рассказать магазину о возврате, который уже сделан в Airwallex.
 *
 * Все проверки — ЗДЕСЬ, по свежему состоянию: между постановкой задачи и её выполнением
 * возврат мог сорваться, а запись в магазине — появиться руками владельца.
 *
 * Денег обработчик не двигает (см. `refundPush.ts`): он лишь сообщает магазину о свершившемся,
 * а письмо клиенту «возврат оформлен» отправляет сам WooCommerce своим шаблоном.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { resolveWooCredentials } from "./credentials";
import { findRecordedRefund, recordWooRefund } from "./refundPush";
import type { WooRefundPushPayload } from "./refundPushEvents";
import { findRefundById } from "@/integrations/airwallex/refund";

/** Возвраты, которые не состоятся: записывать их в магазин и слать письмо клиенту нельзя. */
const DEAD_REFUND_STATUSES = ["FAILED", "CANCELLED", "EXPIRED", "DECLINED"];

export function buildWooRefundPushHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as WooRefundPushPayload;
    if (!p?.orderId || !p?.refundId) return;

    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: { id: true, siteId: true, externalId: true, platform: true, orderNumber: true },
    });
    if (!order || order.platform !== "WOOCOMMERCE" || !order.externalId) return;

    // Возврат мог сорваться уже после создания. Спрашиваем Airwallex, а не свою запись: правда
    // о деньгах там, и письмо клиенту должно опираться на неё. Недоступность Airwallex — повод
    // повторить позже, а не молча не записать возврат.
    const found = await findRefundById(order.id, p.refundId);
    if (!found.ok) {
      console.info(`[woo] ${order.orderNumber}: Airwallex не ответил про возврат (${found.code}) — повторим`);
      throw new Error(`airwallex_refund_lookup_failed:${found.code}`);
    }
    const refund = found.refund;
    if (!refund) {
      console.warn(`[woo] ${order.orderNumber}: возврат ${p.refundId} не найден в Airwallex — в магазин не пишем`);
      return;
    }
    if (DEAD_REFUND_STATUSES.includes(refund.status.toUpperCase())) {
      console.info(`[woo] ${order.orderNumber}: возврат ${p.refundId} в статусе ${refund.status} — в магазин не пишем`);
      return;
    }

    const creds = await resolveWooCredentials(order.siteId);

    // Уже записан — второй раз не пишем: повтор задачи не должен удваивать возврат в отчётах
    // магазина и присылать клиенту второе письмо.
    const existing = await findRecordedRefund(creds, order.externalId, p.refundId);
    if (existing) {
      console.info(`[woo] ${order.orderNumber}: возврат ${p.refundId} уже записан в магазине (#${existing})`);
      return;
    }

    const id = await recordWooRefund(creds, order.externalId, {
      amount: refund.amount,
      reason: p.reason,
      airwallexRefundId: p.refundId,
    });
    console.info(`[woo] ${order.orderNumber}: возврат ${refund.amount} ${refund.currency} записан в магазине (#${id})`);
    // Дальше магазин сам: письмо клиенту о возврате, статус заказа при полном возврате и
    // вебхук order.updated, по которому обычный приём обновит заказ у нас.
  };
}
