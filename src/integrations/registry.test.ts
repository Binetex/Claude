import { describe, it, expect } from "vitest";
import { getOrderAdapter, getWebhookAdapter, getConnectionAdapter } from "./registry";

describe("integration registry — резолв адаптеров по платформе", () => {
  it("возвращает адаптеры с совпадающей платформой", () => {
    for (const p of ["SHOPIFY", "WOOCOMMERCE"] as const) {
      expect(getOrderAdapter(p).platform).toBe(p);
      expect(getWebhookAdapter(p).platform).toBe(p);
      expect(getConnectionAdapter(p).platform).toBe(p);
    }
  });

  it("ConnectionAdapter выводит статус из наличия credentials (без сети)", async () => {
    const shopify = getConnectionAdapter("SHOPIFY");
    expect(await shopify.checkStatus({ platform: "SHOPIFY", shopDomain: "s.myshopify.com", accessToken: "shpat_x" })).toBe("CONNECTED");
    expect(await shopify.checkStatus({ platform: "SHOPIFY", shopDomain: null, accessToken: null })).toBe("DISCONNECTED");
  });
});
