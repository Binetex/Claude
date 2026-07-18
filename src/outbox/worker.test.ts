import { describe, it, expect, vi } from "vitest";
import { InMemoryOutboxRepository } from "./memoryRepository";
import { OutboxWorker, type OutboxHandler } from "./worker";
import { OutboxLogger, type OutboxLogLine } from "./logger";
import { IntegrationError } from "@/integrations/errors";
import type { NewOutboxEvent } from "./types";

const T0 = new Date("2026-07-18T00:00:00Z");
const ev = (over: Partial<NewOutboxEvent> = {}): NewOutboxEvent => ({
  eventType: "test.event",
  aggregateType: "order",
  aggregateId: "o1",
  payload: { orderId: "o1" },
  idempotencyKey: "k1",
  availableAt: new Date(T0),
  ...over,
});

const noSleep = async () => {};

function makeWorker(handlers: Record<string, OutboxHandler>, clock: { t: number }, opts: { sink?: (l: OutboxLogLine) => void } = {}) {
  const repo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker({
    repo,
    handlers,
    workerId: "W1",
    now: () => new Date(clock.t),
    sleep: noSleep,
    logger: new OutboxLogger(opts.sink),
    policy: { batchSize: 10, pollIntervalMs: 0, stuckAfterMs: 60_000, retry: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 } },
  });
  return { repo, worker };
}

describe("OutboxWorker — успешная обработка", () => {
  it("успех → PROCESSED", async () => {
    const clock = { t: T0.getTime() };
    const handler = vi.fn(async () => {});
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev());
    const res = await worker.tick();
    expect(res.processed).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    expect((await repo.list())[0].status).toBe("PROCESSED");
  });

  it("неизвестный тип события → DEAD_LETTER (не теряется, не крутится)", async () => {
    const clock = { t: T0.getTime() };
    const { repo, worker } = makeWorker({}, clock);
    await repo.enqueue(ev({ eventType: "unknown.event" }));
    const res = await worker.tick();
    expect(res.deadLettered).toBe(1);
    expect((await repo.list())[0].status).toBe("DEAD_LETTER");
  });
});

describe("OutboxWorker — повторы и dead-letter", () => {
  it("retryable ошибка → новая попытка, затем успех", async () => {
    const clock = { t: T0.getTime() };
    let calls = 0;
    const handler: OutboxHandler = async () => {
      calls++;
      if (calls === 1) throw new IntegrationError("temp", { kind: "retryable", platform: "t" });
    };
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev());

    const t1 = await worker.tick();
    expect(t1.retried).toBe(1);
    expect((await repo.list())[0].status).toBe("FAILED");

    clock.t = T0.getTime() + 1000; // за пределами backoff
    const t2 = await worker.tick();
    expect(t2.processed).toBe(1);
    expect((await repo.list())[0].status).toBe("PROCESSED");
    expect(calls).toBe(2);
  });

  it("non-retryable ошибка → DEAD_LETTER без повторов", async () => {
    const clock = { t: T0.getTime() };
    const handler: OutboxHandler = async () => {
      throw new IntegrationError("bad", { kind: "permanent", platform: "t" });
    };
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev());
    const res = await worker.tick();
    expect(res.deadLettered).toBe(1);
    expect((await repo.list())[0].status).toBe("DEAD_LETTER");
  });

  it("исчерпание попыток → DEAD_LETTER", async () => {
    const clock = { t: T0.getTime() };
    const handler: OutboxHandler = async () => {
      throw new IntegrationError("temp", { kind: "retryable", platform: "t" });
    };
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev({ maxAttempts: 2 }));
    await worker.tick(); // attempt 1 → FAILED
    clock.t += 1000;
    const res = await worker.tick(); // attempt 2 == max → DEAD_LETTER
    expect(res.deadLettered).toBe(1);
    expect((await repo.list())[0].status).toBe("DEAD_LETTER");
  });
});

describe("OutboxWorker — восстановление зависших", () => {
  it("tick восстанавливает и затем обрабатывает зависшее PROCESSING", async () => {
    const clock = { t: T0.getTime() };
    const handler = vi.fn(async () => {});
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev());
    // Симулируем зависание: другой worker забрал и «умер».
    await repo.claimBatch({ workerId: "dead", limit: 1, now: new Date(clock.t) });
    clock.t += 70_000; // больше stuckAfterMs

    const res = await worker.tick();
    expect(res.recovered).toBe(1);
    expect(res.processed).toBe(1);
    expect((await repo.list())[0].status).toBe("PROCESSED");
  });
});

describe("OutboxWorker — graceful shutdown", () => {
  it("stop() завершает цикл start()", async () => {
    const clock = { t: T0.getTime() };
    const processed: string[] = [];
    const handler: OutboxHandler = async (r) => {
      processed.push(r.id);
      worker.stop(); // останавливаемся после первого события
    };
    const { repo, worker } = makeWorker({ "test.event": handler }, clock);
    await repo.enqueue(ev());
    await worker.start(); // должно завершиться после stop()
    expect(processed).toHaveLength(1);
  });

  it("start() выходит по stop() даже без событий", async () => {
    const clock = { t: T0.getTime() };
    const { worker } = makeWorker({}, clock);
    const p = worker.start();
    worker.stop();
    await expect(p).resolves.toBeUndefined();
  });
});

describe("OutboxWorker — безопасные логи (без PII/payload)", () => {
  it("payload события не попадает в логи", async () => {
    const clock = { t: T0.getTime() };
    const lines: OutboxLogLine[] = [];
    const handler: OutboxHandler = async () => {};
    const { repo, worker } = makeWorker({ "test.event": handler }, clock, { sink: (l) => lines.push(l) });
    await repo.enqueue(
      ev({ payload: { orderId: "o1", recipientPhone: "SENTINEL-5551234", cardMessage: "SENTINEL-CARD" } })
    );
    await worker.tick();

    const dump = JSON.stringify(lines);
    expect(dump).not.toContain("SENTINEL-5551234");
    expect(dump).not.toContain("SENTINEL-CARD");
    // но структурные безопасные поля присутствуют
    expect(lines.some((l) => l.event === "handler.succeeded" && l.eventType === "test.event")).toBe(true);
  });
});
