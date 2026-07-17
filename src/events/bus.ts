/**
 * In-process шина доменных событий. Безопасная реализация для текущего single-VPS
 * развёртывания (без внешней очереди). Свойства:
 *  - типобезопасность (payload сверяется с реестром `DomainEventMap`);
 *  - идемпотентность: событие с уже виденным `idempotencyKey` не обрабатывается повторно;
 *  - изоляция хендлеров: падение одного подписчика не мешает остальным;
 *  - повторы: ретраябельные ошибки хендлера повторяются по централизованной политике;
 *  - журнал обработки для наблюдаемости/отладки.
 *
 * Замена на Redis/BullMQ позже: сохранить сигнатуры `on`/`publish`, вынести доставку в воркер.
 */
import { runWithRetry } from "@/integrations/retry";
import type {
  DomainEventName,
  DomainEventMap,
  EventHandler,
  EventEnvelope,
  EventLogEntry,
} from "./types";

type Registered = { handler: EventHandler; name: string };

export type PublishResult = {
  deduped: boolean;
  handled: number;
  failed: number;
  entries: EventLogEntry[];
};

export type EventBusOptions = {
  /** Максимум ключей идемпотентности в памяти (LRU-обрезка). */
  maxSeenKeys?: number;
  /** Максимум записей журнала в памяти. */
  maxLog?: number;
  /** Инъекция sleep для повторов (тесты). */
  sleep?: (ms: number) => Promise<void>;
};

export class EventBus {
  private handlers = new Map<DomainEventName, Registered[]>();
  private seen = new Set<string>();
  private log: EventLogEntry[] = [];
  private readonly maxSeenKeys: number;
  private readonly maxLog: number;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(opts: EventBusOptions = {}) {
    this.maxSeenKeys = opts.maxSeenKeys ?? 10_000;
    this.maxLog = opts.maxLog ?? 1_000;
    this.sleep = opts.sleep;
  }

  /** Подписка. `handlerName` используется в журнале. Возвращает функцию отписки. */
  on<K extends DomainEventName>(
    name: K,
    handler: EventHandler<K>,
    handlerName = handler.name || "anonymous"
  ): () => void {
    const list = this.handlers.get(name) ?? [];
    const entry: Registered = { handler: handler as EventHandler, name: handlerName };
    list.push(entry);
    this.handlers.set(name, list);
    return () => {
      const cur = this.handlers.get(name);
      if (cur) this.handlers.set(name, cur.filter((h) => h !== entry));
    };
  }

  /**
   * Публикация события. Идемпотентна по `idempotencyKey`: повторная публикация того же
   * ключа не запускает хендлеры (deduped=true). Хендлеры изолированы: ошибка одного не
   * останавливает других; ретраябельные ошибки повторяются.
   */
  async publish<K extends DomainEventName>(
    name: K,
    payload: DomainEventMap[K],
    opts: { idempotencyKey: string }
  ): Promise<PublishResult> {
    const dedupKey = `${name}::${opts.idempotencyKey}`;
    if (this.seen.has(dedupKey)) {
      return { deduped: true, handled: 0, failed: 0, entries: [] };
    }
    this.markSeen(dedupKey);

    const envelope: EventEnvelope<K> = {
      name,
      payload,
      idempotencyKey: opts.idempotencyKey,
      occurredAt: new Date().toISOString(),
      attempt: 1,
    };

    const list = this.handlers.get(name) ?? [];
    const entries: EventLogEntry[] = [];
    let handled = 0;
    let failed = 0;

    for (const reg of list) {
      const at = new Date().toISOString();
      try {
        // runWithRetry сам повторяет ТОЛЬКО ретраябельные ошибки (см. errors.ts);
        // permanent/обычные — пробрасываются сразу. Так достигается изоляция:
        // ошибка одного хендлера не прерывает цикл по остальным.
        await runWithRetry(async () => reg.handler(payload, envelope as EventEnvelope), {
          sleep: this.sleep,
        });
        handled++;
        entries.push({ name, idempotencyKey: opts.idempotencyKey, handler: reg.name, ok: true, attempt: 1, at });
      } catch (err) {
        failed++;
        entries.push({
          name,
          idempotencyKey: opts.idempotencyKey,
          handler: reg.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          attempt: 1,
          at,
        });
      }
    }

    this.appendLog(entries);
    return { deduped: false, handled, failed, entries };
  }

  /** Копия журнала обработки (для наблюдаемости/тестов). */
  getLog(): readonly EventLogEntry[] {
    return [...this.log];
  }

  /** Сбрасывает состояние (для тестов). */
  reset(): void {
    this.handlers.clear();
    this.seen.clear();
    this.log = [];
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    if (this.seen.size > this.maxSeenKeys) {
      // Простая обрезка: удаляем самый старый ключ (Set сохраняет порядок вставки).
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private appendLog(entries: EventLogEntry[]): void {
    this.log.push(...entries);
    if (this.log.length > this.maxLog) {
      this.log.splice(0, this.log.length - this.maxLog);
    }
  }
}

/** Глобальная шина процесса. Для тестов создавайте свой экземпляр `new EventBus()`. */
export const eventBus = new EventBus();
