/**
 * Guard идемпотентности провайдер-операций. Модель доставки — **at-least-once с best-effort
 * дедупом**: guard подавляет ПОВТОРНОЕ побочное действие (SMS/Telegram, Shopify/Woo fulfillment,
 * Burq-доставка, запись истории) при повторной доставке события (рестарт/ретрай/дубликат вебхука).
 *
 * ВАЖНО: `runOnce` — check-then-act, поэтому строгую «ровно один раз» он НЕ гарантирует при
 * настоящей конкурентной обработке одного события (окно между wasProcessed и markProcessed).
 * Для деплоя это закрывается: воркер запускается в ОДНОМ инстансе (ecosystem.worker.example.js),
 * lease/`FOR UPDATE SKIP LOCKED` не даёт двойного claim, а `stuckAfterMs` держится выше времени
 * обработки. Полное «exactly once» достижимо только идемпотентностью на стороне провайдера.
 *
 * Ключ операции: идемпотентный ключ события + канал/действие, напр. `order.delivery.completed:<orderId>:sms`.
 */

export type ProcessedOperationRecord = { processed: boolean; externalId: string | null };

export interface ProcessedOperationStore {
  wasProcessed(operationKey: string): Promise<ProcessedOperationRecord>;
  /** Фиксирует выполнение. При гонке (ключ уже есть) НЕ должен падать — вернуть тихо. */
  markProcessed(operationKey: string, kind: string, externalId?: string | null): Promise<void>;
}

export type RunOnceResult<T> =
  | { status: "executed"; value: T }
  | { status: "skipped"; externalId: string | null };

/**
 * Выполняет `fn` не более одного раза для данного `operationKey`. Если уже выполнялось —
 * возвращает `skipped` (с сохранённым externalId), НЕ вызывая `fn` повторно.
 * `extractExternalId` достаёт id результата провайдера для сохранения (для аудита/дедупа).
 */
export async function runOnce<T>(
  store: ProcessedOperationStore,
  op: { key: string; kind: string; extractExternalId?: (value: T) => string | null },
  fn: () => Promise<T>
): Promise<RunOnceResult<T>> {
  const prior = await store.wasProcessed(op.key);
  if (prior.processed) {
    return { status: "skipped", externalId: prior.externalId };
  }
  const value = await fn();
  const externalId = op.extractExternalId ? op.extractExternalId(value) : null;
  await store.markProcessed(op.key, op.kind, externalId);
  return { status: "executed", value };
}

/** In-memory реализация (тесты и single-process fallback). */
export class InMemoryProcessedOperationStore implements ProcessedOperationStore {
  private store = new Map<string, string | null>();

  async wasProcessed(operationKey: string): Promise<ProcessedOperationRecord> {
    if (this.store.has(operationKey)) {
      return { processed: true, externalId: this.store.get(operationKey) ?? null };
    }
    return { processed: false, externalId: null };
  }

  async markProcessed(operationKey: string, _kind: string, externalId: string | null = null): Promise<void> {
    // Гонка не страшна: последняя запись эквивалентна (операция уже помечена выполненной).
    if (!this.store.has(operationKey)) this.store.set(operationKey, externalId);
  }
}
