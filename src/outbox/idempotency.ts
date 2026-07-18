/**
 * Guard идемпотентности провайдер-операций. Гарантирует, что конкретное побочное действие
 * (отправка SMS/Telegram, Shopify/Woo fulfillment, создание Burq-доставки, запись истории)
 * выполнится РОВНО один раз, даже если событие доставлено повторно (после рестарта, ретрая
 * или дубликата вебхука).
 *
 * Ключ операции строится из идемпотентного ключа события + канала/действия, напр.
 * `order.delivery.completed:<orderId>:sms`. `runOnce` проверяет запись ДО действия и
 * фиксирует факт выполнения ПОСЛЕ — с обработкой гонки (двойная фиксация → уже выполнено).
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
