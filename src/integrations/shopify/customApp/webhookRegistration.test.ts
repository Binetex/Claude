/**
 * Unit-тест регистрации webhooks. Shopify GraphQL и prisma замоканы — проверяем чистую
 * логику идемпотентности на полном наборе REQUIRED_WEBHOOK_TOPICS:
 *  - существующие подписки с НАШИМ callbackUrl не пересоздаются (нет дублей);
 *  - создаются только отсутствующие;
 *  - все топики сохраняются в ShopifyWebhook (ACTIVE + shopifyWebhookId);
 *  - отказ одного топика не бросает и не откатывает уже созданные.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CALLBACK = "https://floremart.test/api/webhooks/shopify";

vi.mock("@/lib/appUrl", () => ({ getAppUrl: () => "https://floremart.test" }));

const { graphqlMock } = vi.hoisted(() => ({ graphqlMock: vi.fn() }));
vi.mock("./client", () => ({ shopifyAdminGraphQL: graphqlMock }));

const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn((_arg: unknown) => Promise.resolve({})) }));
vi.mock("@/lib/db", () => ({ prisma: { shopifyWebhook: { upsert: upsertMock } } }));

import { registerWebhooks, REQUIRED_WEBHOOK_TOPICS } from "./webhookRegistration";

function existingEdges(entries: { topic: string; callbackUrl: string; id: string }[]) {
  return {
    webhookSubscriptions: {
      edges: entries.map((e) => ({
        node: { id: e.id, topic: e.topic, endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: e.callbackUrl } },
      })),
    },
  };
}

let createCounter = 0;
function wireGraphql(existing: ReturnType<typeof existingEdges>, opts: { failTopic?: string } = {}) {
  createCounter = 0;
  graphqlMock.mockImplementation(async (_siteId: string, query: string, variables?: { topic?: string }) => {
    if (query.includes("webhookSubscriptions(")) return existing;
    // CREATE_MUTATION
    if (opts.failTopic && variables?.topic === opts.failTopic) {
      return { webhookSubscriptionCreate: { userErrors: [{ message: "not allowed for this app" }], webhookSubscription: null } };
    }
    createCounter++;
    return { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: `gid://new/${variables?.topic}` } } };
  });
}

beforeEach(() => {
  graphqlMock.mockReset();
  upsertMock.mockClear();
});

describe("registerWebhooks — идемпотентность и полный набор топиков", () => {
  it("покрывает ровно 10 handler-топиков", () => {
    expect([...REQUIRED_WEBHOOK_TOPICS]).toEqual([
      "ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_FULFILLED",
      "REFUNDS_CREATE", "PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE",
      "APP_UNINSTALLED", "APP_SCOPES_UPDATE",
    ]);
  });

  it("пусто → создаёт все 10, сохраняет каждый ACTIVE с внешним id", async () => {
    wireGraphql(existingEdges([]));
    const res = await registerWebhooks("site1");

    expect(res.created).toEqual([...REQUIRED_WEBHOOK_TOPICS]);
    expect(res.existing).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(createCounter).toBe(10);
    expect(upsertMock).toHaveBeenCalledTimes(10);
    for (const call of upsertMock.mock.calls) {
      const arg = call[0] as { create: { status: string; shopifyWebhookId: string | null } };
      expect(arg.create.status).toBe("ACTIVE");
      expect(arg.create.shopifyWebhookId).toMatch(/^gid:\/\/new\//);
    }
  });

  it("существующие с нашим callbackUrl не пересоздаются (без дублей)", async () => {
    // Две подписки уже есть с НАШИМ callback; одна — с ЧУЖИМ (должна считаться отсутствующей).
    wireGraphql(
      existingEdges([
        { topic: "ORDERS_CREATE", callbackUrl: CALLBACK, id: "gid://old/oc" },
        { topic: "PRODUCTS_UPDATE", callbackUrl: CALLBACK, id: "gid://old/pu" },
        { topic: "ORDERS_UPDATED", callbackUrl: "https://other.example/webhooks", id: "gid://foreign/ou" },
      ])
    );
    const res = await registerWebhooks("site1");

    expect(res.existing.sort()).toEqual(["ORDERS_CREATE", "PRODUCTS_UPDATE"]);
    // ORDERS_UPDATED с чужим callback → создаётся заново; остальные 8 недостающих тоже.
    expect(res.created).toContain("ORDERS_UPDATED");
    expect(res.created).not.toContain("ORDERS_CREATE");
    expect(res.created).not.toContain("PRODUCTS_UPDATE");
    expect(createCounter).toBe(8); // 10 - 2 существующих с нашим callback
    expect(res.failed).toEqual([]);

    // Существующие сохраняются с их прежним внешним id (не перезаписаны новым).
    const ocCall = upsertMock.mock.calls.find((c) => (c[0] as { where: { siteId_topic: { topic: string } } }).where.siteId_topic.topic === "ORDERS_CREATE");
    expect((ocCall![0] as { create: { shopifyWebhookId: string } }).create.shopifyWebhookId).toBe("gid://old/oc");
  });

  it("отказ одного топика → в failed, не бросает, уже созданные остаются", async () => {
    wireGraphql(existingEdges([]), { failTopic: "APP_SCOPES_UPDATE" });
    const res = await registerWebhooks("site1");

    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].topic).toBe("APP_SCOPES_UPDATE");
    expect(res.failed[0].error).toMatch(/not allowed/);
    // Остальные 9 успешно созданы (нет отката).
    expect(res.created).toHaveLength(9);
    expect(res.created).not.toContain("APP_SCOPES_UPDATE");
    // Проваленный топик тоже фиксируется в БД со статусом FAILED.
    const failCall = upsertMock.mock.calls.find((c) => (c[0] as { where: { siteId_topic: { topic: string } } }).where.siteId_topic.topic === "APP_SCOPES_UPDATE");
    expect((failCall![0] as { create: { status: string } }).create.status).toBe("FAILED");
  });
});
