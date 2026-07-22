import { describe, it, expect } from "vitest";
import { fetchWooOrders, countWooOrders, type WooOrderBound } from "./orderFetch";
import type { WooCredentials } from "./credentials";

const creds: WooCredentials = {
  siteId: "s1",
  storeUrl: "https://shop.test",
  apiBaseUrl: "https://shop.test/wp-json/wc/v3",
  apiVersion: "wc/v3",
  consumerKey: "ck",
  consumerSecret: "cs",
};

function mockRes(body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: true, status: 200, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Захватывает URL первого GET и возвращает его searchParams. */
async function captureQuery(bound: WooOrderBound): Promise<URLSearchParams> {
  let captured = "";
  const client = {
    fetchImpl: async (url: string) => {
      if (!captured) captured = url;
      return mockRes([]); // пустая страница → генератор останавливается
    },
    sleep: async () => {},
  };
  // прогоняем генератор до конца (одна пустая страница)
  for await (const _ of fetchWooOrders(creds, bound, client)) void _;
  return new URL(captured).searchParams;
}

describe("fetchWooOrders — точный GET /orders по границе", () => {
  it("modifiedAfter → modified_after=<ISO>, без after", async () => {
    const q = await captureQuery({ modifiedAfter: "2026-07-10T08:00:00.000Z" });
    expect(q.get("modified_after")).toBe("2026-07-10T08:00:00.000Z");
    expect(q.get("after")).toBeNull();
    expect(q.get("orderby")).toBe("date");
    expect(q.get("order")).toBe("asc");
  });

  it("after → after=<ISO>, без modified_after (начальное окно)", async () => {
    const q = await captureQuery({ after: "2026-07-04T12:00:00.000Z" });
    expect(q.get("after")).toBe("2026-07-04T12:00:00.000Z");
    expect(q.get("modified_after")).toBeNull();
  });

  it("пустая граница → ни after, ни modified_after (вся история)", async () => {
    const q = await captureQuery({});
    expect(q.get("after")).toBeNull();
    expect(q.get("modified_after")).toBeNull();
  });

  it("countWooOrders прокидывает границу с per_page=1", async () => {
    let capturedUrl = "";
    const client = { fetchImpl: async (url: string) => { capturedUrl = url; return mockRes([], { "x-wp-total": "7" }); }, sleep: async () => {} };
    const total = await countWooOrders(creds, { modifiedAfter: "2026-07-10T08:00:00.000Z" }, client);
    const q = new URL(capturedUrl).searchParams;
    expect(total).toBe(7);
    expect(q.get("per_page")).toBe("1");
    expect(q.get("modified_after")).toBe("2026-07-10T08:00:00.000Z");
  });
});
