import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { reconcileAirwallexPayment } from "./reconcile";
import type { AirwallexVerifyPayload } from "./events";

/**
 * Обработчик сверки одного заказа. Ошибки Airwallex внутри reconcile уже превращаются в
 * backoff-план (запись переносится на более поздний nextCheckAt), поэтому сюда исключения
 * доходят только при поломке БД — тогда outbox честно повторит.
 */
export function buildAirwallexVerifyHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as AirwallexVerifyPayload;
    if (!p?.orderId) return;
    const r = await reconcileAirwallexPayment(prisma, p.orderId);
    if (r.outcome !== "reconciled" && r.outcome !== "pending") {
      console.info(`[airwallex] ${p.orderId}: ${r.outcome}${r.normalized ? ` (${r.normalized})` : ""}`);
    }
  };
}
