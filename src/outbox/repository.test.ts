import { describe, it, expect } from "vitest";
import { InMemoryOutboxRepository } from "./memoryRepository";
import type { NewOutboxEvent } from "./types";

const ev = (over: Partial<NewOutboxEvent> = {}): NewOutboxEvent => ({
  eventType: "order.delivery.completed",
  aggregateType: "order",
  aggregateId: "o1",
  payload: { orderId: "o1" },
  idempotencyKey: "k1",
  availableAt: T0,
  ...over,
});

const T0 = new Date("2026-07-18T00:00:00Z");
const at = (msOffset: number) => new Date(T0.getTime() + msOffset);

describe("OutboxRepository — публикация и хранение до обработки", () => {
  it("сохраняет событие в PENDING (доступно до обработки)", async () => {
    const repo = new InMemoryOutboxRepository();
    const { record, created } = await repo.enqueue(ev());
    expect(created).toBe(true);
    expect(record.status).toBe("PENDING");
    expect(record.attempts).toBe(0);
    const pending = await repo.list({ status: "PENDING" });
    expect(pending).toHaveLength(1);
  });

  it("идемпотентна по idempotencyKey (повтор не создаёт дубль)", async () => {
    const repo = new InMemoryOutboxRepository();
    const a = await repo.enqueue(ev());
    const b = await repo.enqueue(ev({ payload: { orderId: "other" } }));
    expect(b.created).toBe(false);
    expect(b.record.id).toBe(a.record.id);
  });
});

describe("OutboxRepository — claim/lease: два worker'а не берут одно событие", () => {
  it("claimBatch раздаёт непересекающиеся наборы", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev({ idempotencyKey: "k1" }));
    await repo.enqueue(ev({ idempotencyKey: "k2" }));
    await repo.enqueue(ev({ idempotencyKey: "k3" }));

    const a = await repo.claimBatch({ workerId: "A", limit: 2, now: T0 });
    const b = await repo.claimBatch({ workerId: "B", limit: 5, now: T0 });

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    const ids = new Set([...a, ...b].map((r) => r.id));
    expect(ids.size).toBe(3); // нет пересечения
    expect(a.every((r) => r.status === "PROCESSING" && r.attempts === 1 && r.lockedBy === "A")).toBe(true);

    const c = await repo.claimBatch({ workerId: "C", limit: 5, now: T0 });
    expect(c).toHaveLength(0); // всё уже в PROCESSING
  });
});

describe("OutboxRepository — успех/провал", () => {
  it("markProcessed → PROCESSED", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev());
    const [r] = await repo.claimBatch({ workerId: "A", limit: 1, now: T0 });
    await repo.markProcessed(r.id, T0);
    const got = await repo.getById(r.id);
    expect(got?.status).toBe("PROCESSED");
    expect(got?.processedAt).not.toBeNull();
  });

  it("fail(retry) → FAILED, доступно только после availableAt", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev());
    const [r] = await repo.claimBatch({ workerId: "A", limit: 1, now: T0 });
    await repo.fail(r.id, { deadLetter: false, availableAt: at(5000), error: "temp", now: T0 });

    expect((await repo.getById(r.id))?.status).toBe("FAILED");
    expect(await repo.claimBatch({ workerId: "A", limit: 5, now: at(1000) })).toHaveLength(0); // ещё рано
    expect(await repo.claimBatch({ workerId: "A", limit: 5, now: at(6000) })).toHaveLength(1); // доступно
  });

  it("fail(deadLetter) → DEAD_LETTER, не берётся в работу", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev());
    const [r] = await repo.claimBatch({ workerId: "A", limit: 1, now: T0 });
    await repo.fail(r.id, { deadLetter: true, availableAt: T0, error: "permanent", now: T0 });
    expect((await repo.getById(r.id))?.status).toBe("DEAD_LETTER");
    expect(await repo.claimBatch({ workerId: "A", limit: 5, now: at(10000) })).toHaveLength(0);
  });

  it("requeue возвращает DEAD_LETTER в PENDING с attempts=0", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev());
    const [r] = await repo.claimBatch({ workerId: "A", limit: 1, now: T0 });
    await repo.fail(r.id, { deadLetter: true, availableAt: T0, error: "x", now: T0 });
    const requeued = await repo.requeue(r.id, at(1000));
    expect(requeued?.status).toBe("PENDING");
    expect(requeued?.attempts).toBe(0);
  });
});

describe("OutboxRepository — восстановление зависших PROCESSING", () => {
  it("зависший (lockedAt старее порога) возвращается в FAILED", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev());
    await repo.claimBatch({ workerId: "dead-worker", limit: 1, now: T0 }); // lockedAt=T0
    const recovered = await repo.recoverStuck({ olderThan: at(60_000), now: at(70_000) });
    expect(recovered).toBe(1);
    const [r] = await repo.list();
    expect(r.status).toBe("FAILED");
    expect(r.lockedBy).toBeNull();
  });

  it("зависший с исчерпанными попытками → DEAD_LETTER", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.enqueue(ev({ maxAttempts: 1 }));
    await repo.claimBatch({ workerId: "dead", limit: 1, now: T0 }); // attempts→1 == max
    await repo.recoverStuck({ olderThan: at(60_000), now: at(70_000) });
    expect((await repo.list())[0].status).toBe("DEAD_LETTER");
  });
});
