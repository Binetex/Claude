/**
 * Outbox worker. НЕ запускается внутри request lifecycle Next.js — предназначен для
 * отдельного процесса (см. scripts/outbox-worker.ts, floremart-worker в PM2).
 *
 * Цикл одного тика:
 *   1) восстановить зависшие PROCESSING (worker умер, не сняв lease);
 *   2) атомарно забрать батч доступных событий (lock/lease, attempts++);
 *   3) обработать каждое своим handler'ом; успех → PROCESSED; сбой → backoff/FAILED или
 *      DEAD_LETTER (по ретраябельности и исчерпанию попыток).
 * Graceful shutdown: stop() доводит текущий батч и выходит из цикла.
 *
 * Чистый класс (без server-only) — тестируется на InMemoryOutboxRepository без БД.
 */
import { computeBackoffMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/integrations/retry";
import { IntegrationError } from "@/integrations/errors";
import { OutboxLogger, safeError } from "./logger";
import type { OutboxRepository, OutboxRecord } from "./types";

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export type OutboxWorkerPolicy = {
  batchSize: number;
  pollIntervalMs: number;
  /** PROCESSING старше этого времени считается зависшим и восстанавливается. */
  stuckAfterMs: number;
  retry: RetryPolicy;
  /** Через сколько перепроверять событие, для которого нет обработчика. */
  unknownHandlerRetryMs: number;
  /**
   * Сколько всего ждать появления обработчика, считая от создания события. Порог отделяет
   * «сборка без обработчика» (чинится деплоем за минуты-часы) от «тип выведен из
   * употребления» (обработчика не будет никогда — вот тогда DEAD_LETTER).
   */
  unknownHandlerGiveUpMs: number;
};

export const DEFAULT_WORKER_POLICY: OutboxWorkerPolicy = {
  batchSize: 20,
  pollIntervalMs: 1000,
  stuckAfterMs: 60_000,
  retry: DEFAULT_RETRY_POLICY,
  unknownHandlerRetryMs: 5 * 60_000, // 5 минут
  unknownHandlerGiveUpMs: 3 * 24 * 60 * 60_000, // 3 суток
};

export type TickResult = { recovered: number; claimed: number; processed: number; retried: number; deadLettered: number };

export type OutboxWorkerDeps = {
  repo: OutboxRepository;
  handlers: Record<string, OutboxHandler>;
  logger?: OutboxLogger;
  workerId?: string;
  policy?: Partial<OutboxWorkerPolicy>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Сигнал наружу о безвозвратно потерянном событии. Раньше DEAD_LETTER не сообщал никуда,
   * и потерю замечали много позже — по отсутствию SMS. Очередь намеренно ничего не знает про
   * Telegram: канал подключается в scripts/outbox-worker.ts.
   */
  onDeadLetter?: (record: OutboxRecord, err: unknown) => Promise<void>;
  /**
   * Отметка живости: вызывается КАЖДЫМ циклом поллинга, как часто писать — решает сама
   * (см. outbox/heartbeat.ts). Ставится из цикла, а не отдельным setInterval, чтобы отметка
   * означала «тик реально прошёл», а не «процесс ещё не убит»: зависший на внешнем вызове
   * воркер жив для ОС, но очередь не двигает.
   */
  heartbeat?: (workerId: string, now: Date) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OutboxWorker {
  private readonly repo: OutboxRepository;
  private readonly handlers: Record<string, OutboxHandler>;
  private readonly logger: OutboxLogger;
  private readonly workerId: string;
  private readonly policy: OutboxWorkerPolicy;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDeadLetter?: (record: OutboxRecord, err: unknown) => Promise<void>;
  private readonly heartbeat?: (workerId: string, now: Date) => Promise<void>;
  private stopping = false;
  private looping = false;

  constructor(deps: OutboxWorkerDeps) {
    this.repo = deps.repo;
    this.handlers = deps.handlers;
    this.logger = deps.logger ?? new OutboxLogger();
    this.workerId = deps.workerId ?? `worker-${process.pid ?? "0"}-${Math.random().toString(36).slice(2, 8)}`;
    this.policy = { ...DEFAULT_WORKER_POLICY, ...deps.policy, retry: deps.policy?.retry ?? DEFAULT_WORKER_POLICY.retry };
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.onDeadLetter = deps.onDeadLetter;
    this.heartbeat = deps.heartbeat;
  }

  /**
   * Уведомление о потере. Падение самого уведомителя НЕ должно ломать воркер: событие уже
   * помечено, а очередь важнее сигнала о ней.
   */
  private async notifyDeadLetter(record: OutboxRecord, err: unknown): Promise<void> {
    if (!this.onDeadLetter) return;
    try {
      await this.onDeadLetter(record, err);
    } catch (e) {
      console.error(`[outbox] уведомление о dead-letter не отправлено:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** Один тик: восстановление зависших + обработка одного батча. Возвращает статистику. */
  async tick(): Promise<TickResult> {
    const now = this.now();
    const recovered = await this.repo.recoverStuck({
      olderThan: new Date(now.getTime() - this.policy.stuckAfterMs),
      now,
    });

    const batch = await this.repo.claimBatch({ workerId: this.workerId, limit: this.policy.batchSize, now });
    let processed = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const record of batch) {
      if (this.stopping) break; // graceful: не начинаем новую обработку при остановке
      const outcome = await this.process(record);
      if (outcome === "processed") processed++;
      else if (outcome === "retry") retried++;
      else deadLettered++;
    }
    return { recovered, claimed: batch.length, processed, retried, deadLettered };
  }

  private async process(record: OutboxRecord): Promise<"processed" | "retry" | "dead_letter"> {
    const handler = this.handlers[record.eventType];
    const now = this.now();

    if (!handler) {
      // Незнакомый тип события — это сломанный ВОРКЕР, а не сломанное событие: само событие
      // корректно, обработчик просто отсутствует в этой сборке. Чинится деплоем, поэтому
      // событие ОТКЛАДЫВАЕМ и не тратим попытку — после выката всё накопившееся уедет само.
      //
      // Раньше здесь был мгновенный DEAD_LETTER с первой же попытки. Это стоило 36 авто-SMS
      // 3 августа 2026: коммит финансов случайно снёс три строки из реестра обработчиков, и
      // каждое событие автоматизаций умирало безвозвратно, пока публикация продолжала работать.
      const ageMs = now.getTime() - record.createdAt.getTime();
      if (ageMs < this.policy.unknownHandlerGiveUpMs) {
        const reason = `no handler for eventType ${record.eventType} — ждём сборку с обработчиком`;
        await this.repo.defer(record.id, { availableAt: new Date(now.getTime() + this.policy.unknownHandlerRetryMs), reason, now });
        this.logger.retryScheduled(record, this.workerId, this.policy.unknownHandlerRetryMs);
        return "retry";
      }
      // Ждали достаточно долго — обработчика, видимо, не будет вовсе (тип выведен из
      // употребления). Только теперь событие честно умирает.
      await this.repo.fail(record.id, { deadLetter: true, availableAt: now, error: `no handler for eventType ${record.eventType}`, now });
      await this.notifyDeadLetter(record, new Error(`no handler for ${record.eventType}`));
      this.logger.deadLetter(record, this.workerId, new Error(`no handler for ${record.eventType}`));
      return "dead_letter";
    }

    this.logger.processingStarted(record, this.workerId);
    try {
      await handler(record);
      await this.repo.markProcessed(record.id, now);
      this.logger.succeeded(record, this.workerId);
      return "processed";
    } catch (err) {
      // Не-IntegrationError считаем временным (transient) по умолчанию: повтор до maxAttempts,
      // затем dead-letter. IntegrationError — по своей классификации.
      const retryable = err instanceof IntegrationError ? err.isRetryable : true;
      const exhausted = record.attempts >= record.maxAttempts;

      if (!retryable || exhausted) {
        await this.repo.fail(record.id, { deadLetter: true, availableAt: now, error: safeError(err), now });
        await this.notifyDeadLetter(record, err);
        this.logger.deadLetter(record, this.workerId, err);
        return "dead_letter";
      }
      const backoffMs = computeBackoffMs(record.attempts, this.policy.retry);
      await this.repo.fail(record.id, { deadLetter: false, availableAt: new Date(now.getTime() + backoffMs), error: safeError(err), now });
      this.logger.retryScheduled(record, this.workerId, backoffMs);
      return "retry";
    }
  }

  /** Запускает бесконечный цикл поллинга. Завершается после stop(). */
  async start(): Promise<void> {
    if (this.looping) throw new Error("worker already started");
    this.looping = true;
    this.stopping = false;
    while (!this.stopping) {
      try {
        const result = await this.tick();
        // Отметка живости — ПОСЛЕ тика: она означает «цикл дошёл до конца», а не «процесс жив».
        if (this.heartbeat) await this.heartbeat(this.workerId, this.now());
        // Если ничего не забрали — ждём интервал; иначе сразу следующий батч (дренаж очереди).
        if (result.claimed === 0 && !this.stopping) await this.sleep(this.policy.pollIntervalMs);
      } catch (err) {
        // Ошибка уровня тика (напр. БД недоступна) не должна ронять процесс — лог и пауза.
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "worker.tick.error", error: safeError(err) }));
        if (!this.stopping) await this.sleep(this.policy.pollIntervalMs);
      }
    }
    this.looping = false;
  }

  /** Graceful shutdown: текущий батч доводится, новый цикл не начинается. */
  stop(): void {
    this.stopping = true;
  }

  get id(): string {
    return this.workerId;
  }
}
