/**
 * Структурированное, БЕЗОПАСНОЕ логирование outbox-worker'а. Пишет строки-JSON только с
 * безопасными полями (id/тип события/агрегат/попытки/статус/безопасная ошибка). НИКОГДА не
 * логирует: payload события целиком, адрес, телефон, текст открытки, credentials, тело вебхука.
 *
 * Sink инъектируется (по умолчанию console) — тесты подставляют массив для проверки,
 * что payload/PII не утекают в логи.
 */
import type { OutboxRecord } from "./types";

export type OutboxLogEvent =
  | "event.queued"
  | "event.processing.started"
  | "handler.succeeded"
  | "handler.failed"
  | "retry.scheduled"
  | "dead_letter";

export type OutboxLogLine = {
  ts: string;
  level: "info" | "warn" | "error";
  event: OutboxLogEvent;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  backoffMs?: number;
  error?: string; // только безопасное, усечённое сообщение
};

export type LogSink = (line: OutboxLogLine) => void;

const consoleSink: LogSink = (line) => {
  const method = line.level === "error" ? console.error : line.level === "warn" ? console.warn : console.log;
  method(JSON.stringify(line));
};

/** Усекает и обезличивает сообщение об ошибке для безопасного лога. */
export function safeError(err: unknown, max = 300): string {
  const msg = err instanceof Error ? err.message : String(err);
  const collapsed = msg.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) + "…" : collapsed;
}

export class OutboxLogger {
  constructor(private readonly sink: LogSink = consoleSink) {}

  private base(record: OutboxRecord) {
    // Явно перечисляем ТОЛЬКО безопасные поля — payload и всё из него не берём.
    return {
      ts: new Date().toISOString(),
      eventId: record.id,
      eventType: record.eventType,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
    };
  }

  queued(record: OutboxRecord): void {
    this.sink({ ...this.base(record), level: "info", event: "event.queued" });
  }
  processingStarted(record: OutboxRecord, workerId: string): void {
    this.sink({ ...this.base(record), level: "info", event: "event.processing.started", workerId });
  }
  succeeded(record: OutboxRecord, workerId: string): void {
    this.sink({ ...this.base(record), level: "info", event: "handler.succeeded", workerId });
  }
  failed(record: OutboxRecord, workerId: string, err: unknown): void {
    this.sink({ ...this.base(record), level: "warn", event: "handler.failed", workerId, error: safeError(err) });
  }
  retryScheduled(record: OutboxRecord, workerId: string, backoffMs: number): void {
    this.sink({ ...this.base(record), level: "warn", event: "retry.scheduled", workerId, backoffMs });
  }
  deadLetter(record: OutboxRecord, workerId: string, err?: unknown): void {
    this.sink({ ...this.base(record), level: "error", event: "dead_letter", workerId, ...(err ? { error: safeError(err) } : {}) });
  }
}
