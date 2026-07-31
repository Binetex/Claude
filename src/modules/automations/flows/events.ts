/**
 * Внутреннее outbox-событие цепочек: «выполнить ОДИН шаг run'а». Второй очереди и второго
 * worker'а нет — используется тот же durable outbox (отложенность через availableAt, повторы
 * с backoff, dead-letter), что и у одиночных правил.
 *
 * Одно событие на один AutomationFlowRunStep. Дедуп публикации — по `flow.step:{runStepId}`:
 * повторный advance (гонка, повторная доставка trigger-события) не поставит вторую отправку.
 */
import type { OutboxRepository } from "@/outbox/types";

export const FLOW_STEP_EVENT = "automation.flow.step";

export type FlowStepPayload = {
  runStepId: string;
  /** Для aggregateId outbox — чтобы события заказа были видны одним запросом. */
  orderId: string;
};

/** Публикует выполнение шага на момент `availableAt` (WAIT — это просто более далёкий момент). */
export async function publishFlowStep(
  repo: OutboxRepository,
  p: FlowStepPayload,
  availableAt: Date
): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: FLOW_STEP_EVENT,
    aggregateType: "order",
    aggregateId: p.orderId,
    payload: p,
    idempotencyKey: `flow.step:${p.runStepId}`,
    availableAt,
  });
  return { created };
}
