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

/**
 * Пауза перед разбором. Люди пишут очередями: «привезите к 11», через двадцать секунд «звоните
 * в домофон». Минута ожидания превращает такую очередь в ОДИН ответ: пока пауза идёт, приходят
 * остальные сообщения, и разбор берёт последнее, видя все в истории (см. handler: `superseded`).
 * Ответ через минуту человек читает как обычную скорость переписки, а не как задержку.
 */
export const ASSISTANT_DELAY_SEC = 60;

/** Идемпотентно по входящему сообщению: одно входящее — один разбор. */
export async function publishAssistantIncoming(
  repo: OutboxRepository,
  communicationId: string,
  keySuffix?: string,
  from: Date = new Date()
): Promise<void> {
  await repo.enqueue({
    eventType: ASSISTANT_INCOMING_EVENT,
    aggregateType: "communication",
    aggregateId: communicationId,
    payload: { communicationId } satisfies AssistantIncomingPayload,
    idempotencyKey: `assistant.incoming:${communicationId}${keySuffix ? `:${keySuffix}` : ""}`,
    availableAt: new Date(from.getTime() + ASSISTANT_DELAY_SEC * 1000),
  });
}

/** Проверка «владелец так и не ответил» — через 20 минут после показа черновика. */
export const ASSISTANT_NUDGE_EVENT = "assistant.nudge";

/** Сколько ждём решения человека, прежде чем сказать клиенту «одну минуту». */
export const NUDGE_AFTER_MIN = 20;

/**
 * Напоминание «one moment» ОТКЛЮЧЕНО владельцем 07.09.2026 («это тоже пока не надо»).
 *
 * Один выключатель на оба конца: новые проверки не ставятся, а уже стоящие в очереди гаснут при
 * исполнении — иначе ближайшие двадцать минут клиенты всё равно получили бы «one moment» по
 * черновикам, созданным до правки. Им же выключена и строчка про напоминание в самом черновике:
 * обещать в Telegram то, чего не будет, хуже, чем не обещать ничего.
 *
 * Вернуть — поставить true: код напоминания цел и покрыт тестами.
 */
export const ASSISTANT_NUDGE_ENABLED = false;

export type AssistantNudgePayload = { turnId: string; dueAt: string };

/**
 * Клиент не должен сидеть в тишине, пока черновик ждёт подтверждения. Одно нейтральное
 * сообщение — и всё: второго напоминания нет, иначе это уже назойливость.
 */
export async function scheduleAssistantNudge(repo: OutboxRepository, turnId: string, from: Date): Promise<void> {
  if (!ASSISTANT_NUDGE_ENABLED) return;
  const dueAt = new Date(from.getTime() + NUDGE_AFTER_MIN * 60_000);
  await repo.enqueue({
    eventType: ASSISTANT_NUDGE_EVENT,
    aggregateType: "aiTurn",
    aggregateId: turnId,
    payload: { turnId, dueAt: dueAt.toISOString() } satisfies AssistantNudgePayload,
    idempotencyKey: `assistant.nudge:${turnId}`,
    availableAt: dueAt,
  });
}
