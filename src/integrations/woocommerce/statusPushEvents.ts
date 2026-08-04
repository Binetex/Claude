import "server-only";
/**
 * Постановка задачи «проставить в Woo `processing`» в outbox.
 *
 * Через очередь, а не прямым запросом из сверки: WordPress бывает медленным и падучим, а
 * сверка платежа не должна ни ждать его, ни ломаться из-за него. Outbox даёт повтор с
 * backoff и dead-letter — то есть подтверждённая оплата не потеряется, если магазин лежал.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";

export const WOO_STATUS_PUSH_EVENT = "woo.status.push_paid";

export type WooStatusPushPayload = { orderId: string };

/**
 * Ключ идемпотентности — на заказ, без попытки и без времени: «оплачен» у заказа бывает
 * один раз, и повторная сверка не должна плодить вторую запись в магазин.
 */
export async function publishWooStatusPush(prisma: PrismaClient, orderId: string): Promise<{ created: boolean }> {
  const repo = new PrismaOutboxRepository(prisma);
  try {
    return await repo.enqueue({
      eventType: WOO_STATUS_PUSH_EVENT,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { orderId },
      idempotencyKey: `woo:status:paid:${orderId}`,
    });
  } catch (err) {
    console.error(`[woo] enqueue status push failed for ${orderId}:`, err instanceof Error ? err.message : String(err));
    return { created: false };
  }
}
