/**
 * Внутренние outbox-события оркестрации авто-SMS. Держим их ОТДЕЛЬНО от доменного реестра
 * (@/events/types): это оркестрация SMS-движка, а не доменные факты. Публикация идёт через
 * существующий durable outbox (dedup по idempotencyKey, отложенность по availableAt) — второй
 * очереди нет. Один trigger-event на факт (по occurrenceKey) и один send-event на job.
 */
import type { OutboxRepository } from "@/outbox/types";

export const SMS_TRIGGER_EVENT = "sms.automation.trigger";
export const SMS_SEND_EVENT = "sms.automation.send";

/** Факт события заказа, на который могут реагировать правила данного Site. */
export type SmsTriggerPayload = {
  orderId: string;
  siteId: string;
  triggerType: string;
  /** Уникальный «случай» триггера (orderId | deliveryId | ...) — часть ключей идемпотентности. */
  occurrenceKey: string;
};

/** Готовый job на отправку (после разворачивания аудитории и проверки условий). */
export type SmsSendPayload = { jobId: string; orderId: string };

/**
 * Публикует trigger-событие. Идемпотентно по `sms.trigger:{triggerType}:{occurrenceKey}` —
 * повторный webhook/sync/ingest НЕ создаёт второй факт.
 */
export async function publishSmsTrigger(repo: OutboxRepository, p: SmsTriggerPayload): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: SMS_TRIGGER_EVENT,
    aggregateType: "order",
    aggregateId: p.orderId,
    payload: p,
    idempotencyKey: `sms.trigger:${p.triggerType}:${p.occurrenceKey}`,
  });
  return { created };
}

/** Публикует отложенную отправку одного job. Идемпотентно по `sms.send:{jobId}`; delay — availableAt. */
export async function publishSmsSend(repo: OutboxRepository, p: SmsSendPayload, availableAt: Date): Promise<{ created: boolean }> {
  const { created } = await repo.enqueue({
    eventType: SMS_SEND_EVENT,
    aggregateType: "order",
    aggregateId: p.orderId,
    payload: p,
    idempotencyKey: `sms.send:${p.jobId}`,
    availableAt,
  });
  return { created };
}
