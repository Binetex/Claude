import "server-only";
/**
 * Событие «пришло входящее — посмотри, надо ли отвечать».
 *
 * Отдельным событием, а не прямо в приёмнике QUO: разбор ходит в модель и может отвечать
 * секундами, а приём входящих обязан оставаться быстрым и не падать из-за чужой недоступности.
 * Очередь та же, что у всего остального фона — второй не заводим.
 */
import type { OutboxRepository } from "@/outbox/types";

export const ASSISTANT_INCOMING_EVENT = "assistant.incoming";

export type AssistantIncomingPayload = { communicationId: string };

/** Идемпотентно по входящему сообщению: одно входящее — один разбор. */
export async function publishAssistantIncoming(repo: OutboxRepository, communicationId: string): Promise<void> {
  await repo.enqueue({
    eventType: ASSISTANT_INCOMING_EVENT,
    aggregateType: "communication",
    aggregateId: communicationId,
    payload: { communicationId } satisfies AssistantIncomingPayload,
    idempotencyKey: `assistant.incoming:${communicationId}`,
  });
}

/** Проверка «владелец так и не ответил» — через 20 минут после показа черновика. */
export const ASSISTANT_NUDGE_EVENT = "assistant.nudge";

/** Сколько ждём решения человека, прежде чем сказать клиенту «одну минуту». */
export const NUDGE_AFTER_MIN = 20;

export type AssistantNudgePayload = { turnId: string };

/**
 * Клиент не должен сидеть в тишине, пока черновик ждёт подтверждения. Одно нейтральное
 * сообщение — и всё: второго напоминания нет, иначе это уже назойливость.
 */
export async function scheduleAssistantNudge(repo: OutboxRepository, turnId: string, from: Date): Promise<void> {
  await repo.enqueue({
    eventType: ASSISTANT_NUDGE_EVENT,
    aggregateType: "aiTurn",
    aggregateId: turnId,
    payload: { turnId } satisfies AssistantNudgePayload,
    idempotencyKey: `assistant.nudge:${turnId}`,
    availableAt: new Date(from.getTime() + NUDGE_AFTER_MIN * 60_000),
  });
}
