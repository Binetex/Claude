import { describe, it, expect, vi } from "vitest";
import { buildShopifyWebhookHandler, type ShopifyWebhookHandlerDeps } from "./webhookHandler";
import type { OutboxRecord } from "@/outbox/types";

function record(payload: unknown): OutboxRecord {
  const now = new Date();
  return {
    id: "obx1", eventType: "shopify.webhook.received", aggregateType: "order", aggregateId: "s1",
    payload, idempotencyKey: "k", status: "PROCESSING", attempts: 1, maxAttempts: 8,
    availableAt: now, lockedAt: now, lockedBy: "W", processedAt: null, lastError: null, createdAt: now, updatedAt: now,
  };
}

function mockDeps() {
  return {
    ingestOrder: vi.fn(async () => {}),
    applyRefund: vi.fn(async () => {}),
    upsertProduct: vi.fn(async () => {}),
    markProductDeleted: vi.fn(async () => {}),
    handleAppUninstalled: vi.fn(async () => {}),
    handleScopesUpdate: vi.fn(async () => {}),
  } satisfies ShopifyWebhookHandlerDeps;
}

describe("buildShopifyWebhookHandler — маршрутизация topic", () => {
  const run = (deps: ShopifyWebhookHandlerDeps, topic: string, shopify: unknown = { id: 1 }) =>
    buildShopifyWebhookHandler(deps)(record({ siteId: "s1", topic, webhookId: "w1", shopify }));

  it("orders/* → ingestOrder с topic", async () => {
    for (const t of ["orders/create", "orders/updated", "orders/cancelled", "orders/fulfilled"]) {
      const d = mockDeps();
      await run(d, t);
      expect(d.ingestOrder).toHaveBeenCalledWith("s1", t, { id: 1 });
      expect(d.upsertProduct).not.toHaveBeenCalled();
    }
  });

  it("refunds/create → applyRefund", async () => {
    const d = mockDeps();
    await run(d, "refunds/create");
    expect(d.applyRefund).toHaveBeenCalledWith("s1", { id: 1 });
  });

  it("products/create|update → upsertProduct; products/delete → markProductDeleted", async () => {
    const d1 = mockDeps(); await run(d1, "products/create"); expect(d1.upsertProduct).toHaveBeenCalledOnce();
    const d2 = mockDeps(); await run(d2, "products/update"); expect(d2.upsertProduct).toHaveBeenCalledOnce();
    const d3 = mockDeps(); await run(d3, "products/delete"); expect(d3.markProductDeleted).toHaveBeenCalledOnce();
  });

  it("app/uninstalled → handleAppUninstalled; app/scopes_update → handleScopesUpdate", async () => {
    const d = mockDeps();
    await run(d, "app/uninstalled");
    expect(d.handleAppUninstalled).toHaveBeenCalledWith("s1");
    await run(d, "app/scopes_update");
    expect(d.handleScopesUpdate).toHaveBeenCalledWith("s1");
  });

  it("неизвестный topic → ничего не вызывает (обработано)", async () => {
    const d = mockDeps();
    await run(d, "carts/create");
    expect(d.ingestOrder).not.toHaveBeenCalled();
    expect(d.upsertProduct).not.toHaveBeenCalled();
  });

  it("нет siteId/topic → ничего", async () => {
    const d = mockDeps();
    await buildShopifyWebhookHandler(d)(record({ topic: "orders/create" })); // нет siteId
    await buildShopifyWebhookHandler(d)(record({ siteId: "s1" })); // нет topic
    expect(d.ingestOrder).not.toHaveBeenCalled();
  });
});
