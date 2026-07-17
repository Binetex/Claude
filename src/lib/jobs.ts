import "server-only";

/**
 * Абстракция фоновых задач.
 *
 * Этап 1: задачи исполняются инлайн (in-memory), без Redis.
 * Позже эта функция заменяется на постановку задачи в BullMQ-очередь —
 * сигнатура вызовов в бизнес-логике не меняется.
 */
export type JobName =
  | "notify.florist.assigned"
  | "order.sync.push"
  | "message.send.sms"
  | "message.send.email";

export async function enqueue(
  name: JobName,
  payload: Record<string, unknown>
): Promise<void> {
  // TODO(этап 2): queue.add(name, payload) через BullMQ.
  // Сейчас — просто лог, чтобы видеть, что задача поставлена.
  if (process.env.NODE_ENV !== "test") {
    console.log(`[job] ${name}`, JSON.stringify(payload));
  }
}
