import "server-only";
/**
 * Prisma-реализация OutboxRepository (Postgres). Ключевое — `claimBatch` использует
 * `SELECT ... FOR UPDATE SKIP LOCKED` в одном UPDATE...RETURNING: это стандартный
 * outbox-паттерн, дающий строгую гарантию, что два конкурентных worker'а никогда не
 * возьмут одну и ту же строку. Остальные операции — через обычный Prisma API.
 *
 * ВНИМАНИЕ: требует применённой миграции 20260718040000_outbox_events. В этой сессии
 * миграция НЕ применяется (см. docs/OUTBOX_AND_WORKER.md) — реализация готова к использованию,
 * но проверяется здесь только типами; поведение покрыто тестами на in-memory реализации.
 */
import { PrismaClient, Prisma } from "@/generated/prisma/client";
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

type Row = {
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

function toRecord(row: Row): OutboxRecord {
  return {
    id: row.id,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt,
    lockedBy: row.lockedBy,
    processedAt: row.processedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(event: NewOutboxEvent): Promise<{ record: OutboxRecord; created: boolean }> {
    try {
      const row = await this.prisma.outboxEvent.create({
        data: {
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload as Prisma.InputJsonValue,
          idempotencyKey: event.idempotencyKey,
          ...(event.maxAttempts != null ? { maxAttempts: event.maxAttempts } : {}),
          ...(event.availableAt != null ? { availableAt: event.availableAt } : {}),
        },
      });
      return { record: toRecord(row as unknown as Row), created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await this.prisma.outboxEvent.findUnique({ where: { idempotencyKey: event.idempotencyKey } });
        if (existing) return { record: toRecord(existing as unknown as Row), created: false };
      }
      throw err;
    }
  }

  async claimBatch(opts: ClaimOptions): Promise<OutboxRecord[]> {
    const now = opts.now ?? new Date();
    // Атомарный claim: строки блокируются SKIP LOCKED, так что параллельные worker'ы
    // получают непересекающиеся наборы. attempts инкрементится здесь же.
    const rows = await this.prisma.$queryRaw<Row[]>`
      UPDATE "OutboxEvent"
      SET status = 'PROCESSING', attempts = attempts + 1, "lockedAt" = ${now}, "lockedBy" = ${opts.workerId}, "updatedAt" = ${now}
      WHERE id IN (
        SELECT id FROM "OutboxEvent"
        WHERE status IN ('PENDING', 'FAILED')
          AND "availableAt" <= ${now}
          AND attempts < "maxAttempts"
        ORDER BY "availableAt" ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    return rows.map(toRecord);
  }

  async markProcessed(id: string, now = new Date()): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: "PROCESSED", processedAt: now, lockedAt: null, lockedBy: null, lastError: null },
    });
  }

  async fail(id: string, opts: FailOptions): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: opts.deadLetter ? "DEAD_LETTER" : "FAILED",
        availableAt: opts.availableAt,
        lastError: opts.error,
        lockedAt: null,
        lockedBy: null,
      },
    });
  }

  async recoverStuck(opts: RecoverOptions): Promise<number> {
    const now = opts.now ?? new Date();
    const stuck = await this.prisma.outboxEvent.findMany({
      where: { status: "PROCESSING", lockedAt: { lt: opts.olderThan } },
      select: { id: true, attempts: true, maxAttempts: true },
    });
    for (const s of stuck) {
      const deadLetter = s.attempts >= s.maxAttempts;
      await this.prisma.outboxEvent.update({
        where: { id: s.id },
        data: {
          status: deadLetter ? "DEAD_LETTER" : "FAILED",
          availableAt: now,
          lastError: "recovered from stuck PROCESSING",
          lockedAt: null,
          lockedBy: null,
        },
      });
    }
    return stuck.length;
  }

  async list(opts: AdminListOptions = {}): Promise<OutboxRecord[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: opts.status ? { status: opts.status } : undefined,
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 100,
    });
    return rows.map((r) => toRecord(r as unknown as Row));
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const row = await this.prisma.outboxEvent.findUnique({ where: { id } });
    return row ? toRecord(row as unknown as Row) : null;
  }

  async requeue(id: string, now = new Date()): Promise<OutboxRecord | null> {
    const existing = await this.prisma.outboxEvent.findUnique({ where: { id } });
    if (!existing) return null;
    if (existing.status !== "FAILED" && existing.status !== "DEAD_LETTER") {
      return toRecord(existing as unknown as Row);
    }
    const row = await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: "PENDING", attempts: 0, availableAt: now, lockedAt: null, lockedBy: null, lastError: null, processedAt: null },
    });
    return toRecord(row as unknown as Row);
  }

  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const grouped = await this.prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } });
    const counts: Record<OutboxStatus, number> = { PENDING: 0, PROCESSING: 0, PROCESSED: 0, FAILED: 0, DEAD_LETTER: 0 };
    for (const g of grouped) counts[g.status as OutboxStatus] = g._count._all;
    return counts;
  }
}
