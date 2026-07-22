import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./bus";
import { IntegrationError } from "@/integrations/errors";

const noSleep = async () => {};
const bus = () => new EventBus({ sleep: noSleep });

describe("EventBus — доставка и подписки", () => {
  it("доставляет событие всем подписчикам с типизированным payload", async () => {
    const b = bus();
    const seen: string[] = [];
    b.on("order.created", (p) => { seen.push(`a:${p.orderId}`); });
    b.on("order.created", (p) => { seen.push(`b:${p.orderId}`); });

    const res = await b.publish("order.created", { orderId: "o1", platform: "SHOPIFY" }, { idempotencyKey: "o1:v1" });
    expect(res.handled).toBe(2);
    expect(res.failed).toBe(0);
    expect(seen).toEqual(["a:o1", "b:o1"]);
  });

  it("отписка прекращает доставку", async () => {
    const b = bus();
    const fn = vi.fn();
    const off = b.on("order.ready", fn);
    off();
    await b.publish("order.ready", { orderId: "o1", floristId: null }, { idempotencyKey: "k1" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("EventBus — идемпотентность", () => {
  it("не обрабатывает повторно тот же idempotencyKey", async () => {
    const b = bus();
    const fn = vi.fn();
    b.on("order.delivery.completed", fn);

    const first = await b.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "o1:done" });
    const second = await b.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "o1:done" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("разные ключи обрабатываются независимо", async () => {
    const b = bus();
    const fn = vi.fn();
    b.on("order.delivery.completed", fn);
    await b.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "k1" });
    await b.publish("order.delivery.completed", { orderId: "o2" }, { idempotencyKey: "k2" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("EventBus — изоляция и повторы", () => {
  it("падение одного хендлера не мешает остальным", async () => {
    const b = bus();
    const good = vi.fn();
    b.on("order.created", () => { throw new Error("boom"); }, "bad");
    b.on("order.created", good, "good");

    const res = await b.publish("order.created", { orderId: "o1", platform: null }, { idempotencyKey: "o1" });
    expect(res.handled).toBe(1);
    expect(res.failed).toBe(1);
    expect(good).toHaveBeenCalledOnce();
  });

  it("повторяет ретраябельную ошибку хендлера и в итоге успевает", async () => {
    const b = bus();
    let calls = 0;
    let lastSeenAttempt = 0;
    b.on("order.assigned", (_p, env) => {
      calls++;
      lastSeenAttempt = env.attempt;
      if (calls < 3) throw new IntegrationError("temp", { kind: "retryable", platform: "test" });
    }, "flaky");

    const res = await b.publish("order.assigned", { orderId: "o1", floristId: "f1" }, { idempotencyKey: "o1:f1" });
    expect(calls).toBe(3);
    expect(res.handled).toBe(1);
    expect(res.failed).toBe(0);
    // Реальный номер попытки виден и хендлеру (envelope.attempt), и журналу (не всегда 1).
    expect(lastSeenAttempt).toBe(3);
    expect(b.getLog().find((e) => e.handler === "flaky")?.attempt).toBe(3);
  });

  it("обычная (не ретраябельная) ошибка не повторяется", async () => {
    const b = bus();
    let calls = 0;
    b.on("order.cancelled", () => { calls++; throw new Error("permanent-ish"); }, "hard");
    const res = await b.publish("order.cancelled", { orderId: "o1", reason: null }, { idempotencyKey: "o1:cancel" });
    expect(calls).toBe(1);
    expect(res.failed).toBe(1);
  });
});

describe("EventBus — журнал", () => {
  it("пишет записи об успехах и ошибках", async () => {
    const b = bus();
    b.on("product.synced", () => {}, "ok");
    b.on("product.synced", () => { throw new Error("x"); }, "fail");
    await b.publish("product.synced", { siteId: "s1", created: 1, updated: 2 }, { idempotencyKey: "s1:sync" });
    const log = b.getLog();
    expect(log).toHaveLength(2);
    expect(log.find((e) => e.handler === "ok")?.ok).toBe(true);
    expect(log.find((e) => e.handler === "fail")?.ok).toBe(false);
  });
});
