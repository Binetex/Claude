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
