import "server-only";
/**
 * Постановка задачи «сообщи магазину о возврате» в outbox.
 *
 * Через очередь, а не прямо из формы возврата: деньги к этому моменту уже возвращены, и
 * недоступный WordPress не должен ни задерживать ответ владельцу, ни отменять сам возврат.
 * Outbox даёт повтор с backoff — письмо клиенту уйдёт, даже если магазин лежал.
 *
 * С паузой: только что созданный возврат Airwallex может ещё сорваться (FAILED), а письмо
 * «вам вернули деньги» по несостоявшемуся возврату отозвать нельзя. Обработчик перед записью
 * перепроверяет статус, и пары минут хватает, чтобы мгновенный отказ уже был виден.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";

export const WOO_REFUND_PUSH_EVENT = "woo.refund.record";

export type WooRefundPushPayload = {
  orderId: string;
  /** id возврата в Airwallex — он же метка записи в Woo и ключ идемпотентности. */
  refundId: string;
  amount: number;
  reason: string;
};

/** Сколько ждём, прежде чем записывать возврат в магазин. */
export const REFUND_PUSH_DELAY_SEC = 120;

export async function publishWooRefundPush(
  prisma: PrismaClient,
  input: WooRefundPushPayload,
  from: Date = new Date()
): Promise<{ created: boolean }> {
  const repo = new PrismaOutboxRepository(prisma);
  try {
    return await repo.enqueue({
      eventType: WOO_REFUND_PUSH_EVENT,
      aggregateType: "order",
      aggregateId: input.orderId,
      payload: input,
      // Один возврат Airwallex — одна запись в магазине.
      idempotencyKey: `woo:refund:${input.refundId}`,
      availableAt: new Date(from.getTime() + REFUND_PUSH_DELAY_SEC * 1000),
    });
  } catch (err) {
    // Возврат уже сделан — падать здесь нельзя: владелец должен увидеть его результат.
    console.error(`[woo] enqueue refund push failed for ${input.orderId}:`, err instanceof Error ? err.message : String(err));
    return { created: false };
  }
}
