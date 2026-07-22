/**
 * Внутренние outbox-события оркестрации Automation Engine. Публикация — через существующий
 * durable outbox (dedup по idempotencyKey, отложенность по availableAt); второй очереди нет.
 * Один trigger-event на факт (по occurrenceKey) и один send-event на job.
 *
 * ВНИМАНИЕ: строковые ЗНАЧЕНИЯ eventType намеренно сохраняют исторический префикс
 * "sms.automation.*", чтобы не осиротить уже поставленные в outbox события при апгрейде
 * (идентификаторы констант обобщены, значения — нет).
 */
import type { OutboxRepository } from "@/outbox/types";

export const AUTOMATION_TRIGGER_EVENT = "sms.automation.trigger";
export const AUTOMATION_SEND_EVENT = "sms.automation.send";

/** Факт события заказа, на который могут реагировать правила данного Site. */
export type AutomationTriggerPayload = {
  orderId: string;
  siteId: string;
  triggerType: string;
  /** Уникальный «случай» триггера (orderId | deliveryId | ...) — часть ключей идемпотентности. */
  occurrenceKey: string;
};

/** Готовый job на отправку (после разворачивания аудитории и проверки условий). */
export type AutomationSendPayload = { jobId: string; orderId: string };

/**
 * Публикует trigger-событие. Идемпотентно по `sms.trigger:{triggerType}:{occurrenceKey}` —
 * повторный webhook/sync/ingest НЕ создаёт второй факт.
 */
export async function publishAutomationTrigger(
  repo: OutboxRepository,
  p: AutomationTriggerPayload,
  /** Отложить факт триггера до этого момента (напр. 9:00 локального дня доставки). */
  availableAt?: Date
): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: AUTOMATION_TRIGGER_EVENT,
    aggregateType: "order",
    aggregateId: p.orderId,
    payload: p,
    idempotencyKey: `sms.trigger:${p.triggerType}:${p.occurrenceKey}`,
    ...(availableAt ? { availableAt } : {}),
  });
  return { created };
}

/** Публикует отложенную отправку одного job. Идемпотентно по `sms.send:{jobId}`; delay — availableAt. */
export async function publishAutomationSend(repo: OutboxRepository, p: AutomationSendPayload, availableAt: Date): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: AUTOMATION_SEND_EVENT,
    aggregateType: "order",
    aggregateId: p.orderId,
    payload: p,
    idempotencyKey: `sms.send:${p.jobId}`,
    availableAt,
  });
  return { created };
}
