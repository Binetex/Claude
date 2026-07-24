import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";

/** Единственное outbox-событие мониторинга: сверить один заказ с Airwallex. */
export const AIRWALLEX_VERIFY_EVENT = "airwallex.verify";

export type AirwallexVerifyPayload = { orderId: string };

/**
 * Ставит задачу сверки. Идемпотентность — на существующем outbox: ключ включает запланированный
 * слот (nextCheckAt), поэтому два воркера, выбравшие одну и ту же запись в одном тике, создадут
 * ОДНО событие, а не два. Отдельная блокировка не нужна.
 */
export async function publishAirwallexVerify(
  prisma: PrismaClient,
  orderId: string,
  slot: Date | null
): Promise<{ created: boolean }> {
  const repo = new PrismaOutboxRepository(prisma);
  const key = `airwallex:verify:${orderId}:${slot ? slot.toISOString() : "now"}`;
  try {
    return await repo.enqueue({
      eventType: AIRWALLEX_VERIFY_EVENT,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { orderId },
      idempotencyKey: key,
    });
  } catch (err) {
    console.error(`[airwallex] enqueue verify failed for ${orderId}:`, err instanceof Error ? err.message : String(err));
    return { created: false };
  }
}
