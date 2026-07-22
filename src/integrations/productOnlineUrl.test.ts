/**
 * Публичная ссылка на товар (Product.onlineUrl) — та, что открывается кнопкой «Открыть на сайте».
 *
 * Различие платформ, из-за которого поле и появилось:
 *  - WooCommerce отдаёт permalink витрины, он же исторически лежит в adminUrl;
 *  - Shopify отдаёт только числовой id, а витрина открывается ТОЛЬКО по handle,
 *    поэтому adminUrl там ведёт в админку и публичной ссылки без handle не построить.
 */
import { describe, it, expect } from "vitest";
import { normalizeWooProduct, type WooProduct } from "./woocommerce/catalogAdapter";
import { normalizeProduct as normalizeShopifyProduct, type ShopifyProduct } from "./shopify/catalogAdapter";

describe("onlineUrl — WooCommerce", () => {
  const woo = (over: Partial<WooProduct> = {}): WooProduct => ({
    id: 10, name: "Rose", type: "simple", status: "publish", price: "50", regular_price: "50",
    permalink: "https://juliesflowers.net/product/rose/", ...over,
  } as WooProduct);

  it("permalink становится публичной ссылкой", () => {
    expect(normalizeWooProduct(woo(), []).onlineUrl).toBe("https://juliesflowers.net/product/rose/");
  });

  it("без permalink остаётся null (кнопки просто не будет)", () => {
    expect(normalizeWooProduct(woo({ permalink: undefined }), []).onlineUrl).toBeNull();
  });

  it("у вариаций собственной публичной ссылки нет — она на уровне товара", () => {
    const np = normalizeWooProduct(woo(), []);
    expect(np.variants[0]).not.toHaveProperty("onlineUrl");
  });
});

describe("onlineUrl — Shopify", () => {
  const shop = "p7mx1v-pz.myshopify.com";

  it("строится из handle, а не из числового id", () => {
    const np = normalizeShopifyProduct(shop, { id: 8388443865133, title: "Amour One", handle: "amour-one" } as ShopifyProduct);
    expect(np.onlineUrl).toBe("https://p7mx1v-pz.myshopify.com/products/amour-one");
  });

  it("adminUrl остаётся ссылкой в админку — это разные адреса", () => {
    const np = normalizeShopifyProduct(shop, { id: 123, title: "X", handle: "x" } as ShopifyProduct);
    expect(np.adminUrl).toBe("https://p7mx1v-pz.myshopify.com/admin/products/123");
    expect(np.onlineUrl).not.toBe(np.adminUrl);
  });

  it("без handle публичной ссылки нет — по id витрина не открывается", () => {
    expect(normalizeShopifyProduct(shop, { id: 123, title: "X" } as ShopifyProduct).onlineUrl).toBeNull();
  });
});
