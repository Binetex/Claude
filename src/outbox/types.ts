/**
 * Persistent outbox: контракт хранилища доменных событий. Даёт надёжность «at-least-once»
 * между рестартами процесса — событие сохраняется ДО обработки, отдельный worker забирает
 * его с lock/lease, повторяет с backoff и уводит окончательно упавшее в DEAD_LETTER.
 *
 * Интерфейс сфокусирован на ХРАНЕНИИ (без бизнес-логики). Политика повторов/бэкоффа живёт
 * в worker'е. Две реализации: in-memory (тесты, полностью покрывает поведение) и Prisma.
 *
 * Учёт попыток: `attempts` инкрементится в момент CLAIM. Значит даже если процесс упал, не
 * успев пометить провал, попытка уже засчитана — poison-событие не зациклится навсегда.
 */

export type OutboxStatus = "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED" | "DEAD_LETTER";

export type OutboxRecord = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  processedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Вход для публикации нового события в outbox. */
export type NewOutboxEvent = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  /** Дедуп публикации: повторный enqueue того же ключа возвращает существующую запись. */
  idempotencyKey: string;
  maxAttempts?: number;
  /** Не брать в обработку раньше этого времени (отложенные события; по умолчанию — сейчас). */
  availableAt?: Date;
};

export type ClaimOptions = {
  workerId: string;
  limit: number;
  now?: Date;
};

export type FailOptions = {
  /** Окончательный провал → DEAD_LETTER (иначе FAILED с повтором). */
  deadLetter: boolean;
  /** Когда снова доступно (для FAILED — now + backoff). */
  availableAt: Date;
  /** Безопасное сообщение об ошибке (без PII/секретов). */
  error: string;
  now?: Date;
};

export type RecoverOptions = {
  /** Считать зависшими PROCESSING с lockedAt раньше этого момента. */
  olderThan: Date;
  now?: Date;
};

export type AdminListOptions = {
  status?: OutboxStatus;
  limit?: number;
};

export interface OutboxRepository {
  /** Идемпотентная публикация. created=false, если событие с таким ключом уже есть. */
  enqueue(event: NewOutboxEvent): Promise<{ record: OutboxRecord; created: boolean }>;

  /**
   * Атомарно забирает до `limit` доступных событий (PENDING/FAILED, availableAt<=now,
   * attempts<maxAttempts): помечает PROCESSING, инкрементит attempts, ставит lease
   * (lockedAt/lockedBy). Гарантирует, что два worker'а не возьмут одно событие.
   */
  claimBatch(opts: ClaimOptions): Promise<OutboxRecord[]>;

  markProcessed(id: string, now?: Date): Promise<void>;

  /** Помечает провал: FAILED (повтор) или DEAD_LETTER; снимает lease. */
  fail(id: string, opts: FailOptions): Promise<void>;

  /**
   * Восстанавливает зависшие PROCESSING (worker умер, не сняв lease). Каждое:
   * attempts уже засчитан при claim → если >=maxAttempts, уводим в DEAD_LETTER,
   * иначе возвращаем в FAILED доступным сейчас. Возвращает число восстановленных.
   */
  recoverStuck(opts: RecoverOptions): Promise<number>;

  // ── Admin (read-only + ручной повтор) ──
  list(opts?: AdminListOptions): Promise<OutboxRecord[]>;
  getById(id: string): Promise<OutboxRecord | null>;
  /** Ручной повтор FAILED/DEAD_LETTER: сброс в PENDING, attempts=0, доступно сейчас. */
  requeue(id: string, now?: Date): Promise<OutboxRecord | null>;
  countByStatus(): Promise<Record<OutboxStatus, number>>;
}
