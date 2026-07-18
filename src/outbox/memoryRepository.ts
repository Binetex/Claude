/**
 * In-memory реализация OutboxRepository. Полностью покрывает поведение (claim/lease,
 * retry, dead-letter, восстановление зависших, идемпотентность) без БД — на ней держатся
 * все поведенческие тесты. Однопоточность JS делает claim атомарным: между выбором и
 * пометкой PROCESSING нет await, поэтому два «параллельных» claimBatch получают
 * непересекающиеся наборы (гарантия «не обработать одно событие дважды»).
 */
import type {
  OutboxRepository,
  OutboxRecord,
  OutboxStatus,
  NewOutboxEvent,
  ClaimOptions,
  FailOptions,
  RecoverOptions,
  AdminListOptions,
} from "./types";

let seq = 0;
const genId = () => `obx_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export class InMemoryOutboxRepository implements OutboxRepository {
  private byId = new Map<string, OutboxRecord>();
  private byKey = new Map<string, string>(); // idempotencyKey → id

  async enqueue(event: NewOutboxEvent): Promise<{ record: OutboxRecord; created: boolean }> {
    const existingId = this.byKey.get(event.idempotencyKey);
    if (existingId) {
      return { record: this.clone(this.byId.get(existingId)!), created: false };
    }
    const now = new Date();
    const record: OutboxRecord = {
      id: genId(),
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
      status: "PENDING",
      attempts: 0,
      maxAttempts: event.maxAttempts ?? 8,
      availableAt: event.availableAt ?? now,
      lockedAt: null,
      lockedBy: null,
      processedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.id, record);
    this.byKey.set(record.idempotencyKey, record.id);
    return { record: this.clone(record), created: true };
  }

  async claimBatch(opts: ClaimOptions): Promise<OutboxRecord[]> {
    const now = opts.now ?? new Date();
    // Синхронная секция (без await) — атомарность claim.
    const claimable = [...this.byId.values()]
      .filter(
        (r) =>
          (r.status === "PENDING" || r.status === "FAILED") &&
          r.availableAt.getTime() <= now.getTime() &&
          r.attempts < r.maxAttempts
      )
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, opts.limit);

    const claimed: OutboxRecord[] = [];
    for (const r of claimable) {
      r.status = "PROCESSING";
      r.attempts += 1;
      r.lockedAt = now;
      r.lockedBy = opts.workerId;
      r.updatedAt = now;
      claimed.push(this.clone(r));
    }
    return claimed;
  }

  async markProcessed(id: string, now = new Date()): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    r.status = "PROCESSED";
    r.processedAt = now;
    r.lockedAt = null;
    r.lockedBy = null;
    r.lastError = null;
    r.updatedAt = now;
  }

  async fail(id: string, opts: FailOptions): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    const now = opts.now ?? new Date();
    r.status = opts.deadLetter ? "DEAD_LETTER" : "FAILED";
    r.availableAt = opts.availableAt;
    r.lastError = opts.error;
    r.lockedAt = null;
    r.lockedBy = null;
    r.updatedAt = now;
  }

  async recoverStuck(opts: RecoverOptions): Promise<number> {
    const now = opts.now ?? new Date();
    let recovered = 0;
    for (const r of this.byId.values()) {
      if (r.status !== "PROCESSING" || !r.lockedAt) continue;
      if (r.lockedAt.getTime() >= opts.olderThan.getTime()) continue;
      // attempts уже засчитан при claim.
      if (r.attempts >= r.maxAttempts) {
        r.status = "DEAD_LETTER";
      } else {
        r.status = "FAILED";
        r.availableAt = now;
      }
      r.lastError = "recovered from stuck PROCESSING";
      r.lockedAt = null;
      r.lockedBy = null;
      r.updatedAt = now;
      recovered++;
    }
    return recovered;
  }

  async list(opts: AdminListOptions = {}): Promise<OutboxRecord[]> {
    let rows = [...this.byId.values()];
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.slice(0, opts.limit ?? 100).map((r) => this.clone(r));
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const r = this.byId.get(id);
    return r ? this.clone(r) : null;
  }

  async requeue(id: string, now = new Date()): Promise<OutboxRecord | null> {
    const r = this.byId.get(id);
    if (!r) return null;
    if (r.status !== "FAILED" && r.status !== "DEAD_LETTER") return this.clone(r);
    r.status = "PENDING";
    r.attempts = 0;
    r.availableAt = now;
    r.lockedAt = null;
    r.lockedBy = null;
    r.lastError = null;
    r.processedAt = null;
    r.updatedAt = now;
    return this.clone(r);
  }

  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const counts: Record<OutboxStatus, number> = {
      PENDING: 0,
      PROCESSING: 0,
      PROCESSED: 0,
      FAILED: 0,
      DEAD_LETTER: 0,
    };
    for (const r of this.byId.values()) counts[r.status]++;
    return counts;
  }

  private clone(r: OutboxRecord): OutboxRecord {
    return { ...r };
  }
}
