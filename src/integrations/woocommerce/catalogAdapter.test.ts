import { describe, it, expect } from "vitest";
import {
  normalizeWooProduct,
  fetchWooProductsWith,
  mapWooProductStatus,
  type WooProduct,
  type WooVariation,
} from "./catalogAdapter";
import type { WooCredentials } from "./credentials";
import type { WooClientOptions } from "./client";

const creds: WooCredentials = {
  siteId: "s1",
  storeUrl: "https://shop.test",
  apiBaseUrl: "https://shop.test/wp-json/wc/v3",
  apiVersion: "wc/v3",
  consumerKey: "ck",
  consumerSecret: "cs",
};

/** Мини-мок Response с нужными методами/заголовками. */
function mockRes(body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("normalizeWooProduct — simple/variable (сценарии 4,5)", () => {
  it("4) simple → один синтетический вариант с ценой товара, externalId=product id", () => {
    const p: WooProduct = { id: 10, name: "Rose", type: "simple", status: "publish", price: "50", regular_price: "50", sku: "R1", images: [{ src: "img" }] };
    const np = normalizeWooProduct(p, []);
    expect(np.externalId).toBe("10");
    expect(np.status).toBe("ACTIVE");
    expect(np.variants).toHaveLength(1);
    expect(np.variants[0]).toMatchObject({ externalId: "10", title: "Default Title", listPrice: 50, sku: "R1" });
  });

  it("5) variable → вариант на каждую вариацию с атрибутами и ценой; distinct externalId", () => {
    const p: WooProduct = { id: 20, name: "Bouquet", type: "variable", status: "publish", variations: [201, 202] };
    const vars: WooVariation[] = [
      { id: 201, price: "100", regular_price: "120", sale_price: "100", on_sale: true, attributes: [{ name: "Size", option: "S" }], stock_status: "instock" },
      { id: 202, price: "180", regular_price: "180", attributes: [{ name: "Size", option: "L" }], stock_status: "instock" },
    ];
    const np = normalizeWooProduct(p, vars);
    expect(np.variants.map((v) => v.externalId)).toEqual(["201", "202"]);
    expect(np.variants[0]).toMatchObject({ listPrice: 100, compareAtPrice: 120, option1: "S" });
    expect(np.variants[1]).toMatchObject({ listPrice: 180, compareAtPrice: null, option1: "L" });
  });

  it("статус: publish→ACTIVE, draft→DRAFT, trash→ARCHIVED", () => {
    expect(mapWooProductStatus("publish")).toBe("ACTIVE");
    expect(mapWooProductStatus("draft")).toBe("DRAFT");
    expect(mapWooProductStatus("trash")).toBe("ARCHIVED");
  });
});

describe("fetchWooProductsWith — пагинация + догрузка вариаций, без дублей", () => {
  it("проходит 2 страницы товаров и тянет вариации variable-товара", async () => {
    const page1: WooProduct[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, type: "simple", status: "publish", price: "10" }));
    const page2: WooProduct[] = [{ id: 999, name: "Var", type: "variable", status: "publish", variations: [1001] }];
    const variations: WooVariation[] = [{ id: 1001, price: "77", attributes: [{ option: "Red" }], stock_status: "instock" }];

    const opts: WooClientOptions = {
      fetchImpl: async (url: string) => {
        if (url.includes("/products/999/variations")) return mockRes(variations, { "x-wp-totalpages": "1" });
        if (url.includes("/products?") || url.includes("/products&") || /\/products\?/.test(url)) {
          const page = new URL(url).searchParams.get("page");
          return page === "1" ? mockRes(page1, { "x-wp-totalpages": "2" }) : mockRes(page2, { "x-wp-totalpages": "2" });
        }
        return mockRes([]);
      },
    };

    const collected: string[] = [];
    for await (const np of fetchWooProductsWith(creds, opts)) collected.push(np.externalId);

    expect(collected).toHaveLength(101); // 100 + 1
    expect(new Set(collected).size).toBe(101); // без дублей
    const varProduct = collected.filter((id) => id === "999");
    expect(varProduct).toHaveLength(1);
  });
});
