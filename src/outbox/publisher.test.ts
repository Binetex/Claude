import { describe, it, expect } from "vitest";
import { InMemoryOutboxRepository } from "./memoryRepository";
import { publishEvent, deriveAggregate, defaultIdempotencyKey } from "./publisher";

describe("publisher — публикация доменных событий в outbox", () => {
  it("сохраняет событие с выведенным агрегатом и ключом", async () => {
    const repo = new InMemoryOutboxRepository();
    const { record, created } = await publishEvent(repo, "order.delivery.completed", { orderId: "o1" });
    expect(created).toBe(true);
    expect(record.eventType).toBe("order.delivery.completed");
    expect(record.aggregateType).toBe("order");
    expect(record.aggregateId).toBe("o1");
    expect(record.idempotencyKey).toBe("order.delivery.completed:o1");
    expect(record.status).toBe("PENDING");
  });

  it("идемпотентна: повторная публикация того же события не дублирует", async () => {
    const repo = new InMemoryOutboxRepository();
    await publishEvent(repo, "order.delivery.completed", { orderId: "o1" });
    const second = await publishEvent(repo, "order.delivery.completed", { orderId: "o1" });
    expect(second.created).toBe(false);
    expect((await repo.list()).length).toBe(1);
  });

  it("site-события маппятся на агрегат site", () => {
    const agg = deriveAggregate("product.synced", { siteId: "s1", created: 1, updated: 2 });
    expect(agg).toEqual({ type: "site", id: "s1" });
    expect(defaultIdempotencyKey("integration.connected", { siteId: "s1", platform: "SHOPIFY" })).toBe(
      "integration.connected:s1"
    );
  });

  it("кастомный idempotencyKey позволяет различать переходы состояний", async () => {
    const repo = new InMemoryOutboxRepository();
    await publishEvent(repo, "order.updated", { orderId: "o1", changed: ["status"] }, { idempotencyKey: "order.updated:o1:v1" });
    await publishEvent(repo, "order.updated", { orderId: "o1", changed: ["florist"] }, { idempotencyKey: "order.updated:o1:v2" });
    expect((await repo.list()).length).toBe(2);
  });
});
