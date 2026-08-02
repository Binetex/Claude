/**
 * Outbox-событие начисления. Отдельной очереди и второго воркера нет — это тот же
 * durable outbox, что у всего остального (см. CLAUDE.md: «Outbox — единственный механизм»).
 */
import type { OutboxRepository } from "@/outbox/types";

export const FINANCE_ACCRUAL_EVENT = "finance.order.accrual";

export type FinanceAccrualPayload = { orderId: string };

/** Ключ дедупликации. Формат — часть контракта с БД, менять нельзя. */
export function financeAccrualKey(orderId: string): string {
  return `finance.accrual:${orderId}`;
}

/**
 * Ставит задачу на начисление. Идемпотентно по заказу: повторная публикация из другого
 * источника доставки (курьер Burq / платформа / ручная отметка владельца) не создаёт
 * второй задачи. Даже если бы создала — сам обработчик идемпотентен по ключу записи.
 */
export async function publishAccrualRequest(repo: OutboxRepository, orderId: string): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: FINANCE_ACCRUAL_EVENT,
    aggregateType: "order",
    aggregateId: orderId,
    payload: { orderId } satisfies FinanceAccrualPayload,
    idempotencyKey: financeAccrualKey(orderId),
  });
  return { created };
}
