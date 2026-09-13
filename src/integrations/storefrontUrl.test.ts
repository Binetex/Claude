import { describe, it, expect } from "vitest";
import { publicProductUrl, normalizeStorefrontDomain } from "./storefrontUrl";

describe("publicProductUrl", () => {
  it("меняет служебный домен Shopify на публичный", () => {
    expect(publicProductUrl("https://pnwhkj-02.myshopify.com/products/french-red-roses", "paradiseflowersart.com")).toBe(
      "https://paradiseflowersart.com/products/french-red-roses"
    );
  });

  it("без публичного домена ссылки нет: внутренний домен наружу не уходит", () => {
    expect(publicProductUrl("https://pnwhkj-02.myshopify.com/products/x", null)).toBeNull();
    expect(publicProductUrl("https://pnwhkj-02.myshopify.com/products/x", "other.myshopify.com")).toBeNull();
  });

  it("чужие ссылки не трогает: у WooCommerce домен уже настоящий", () => {
    expect(publicProductUrl("https://juliesflowers.net/product/red-roses/", null)).toBe("https://juliesflowers.net/product/red-roses/");
  });

  it("мусор вместо ссылки — это отсутствие ссылки, а не исключение", () => {
    expect(publicProductUrl("not a url", "x.com")).toBeNull();
    expect(publicProductUrl(null, "x.com")).toBeNull();
  });
});

describe("normalizeStorefrontDomain", () => {
  it("принимает домен как его вводит человек", () => {
    expect(normalizeStorefrontDomain(" HTTPS://www.TheOhara.com/ ")).toBe("theohara.com");
    expect(normalizeStorefrontDomain("theflow.la")).toBe("theflow.la");
  });

  it("отвергает не-домены и служебный домен Shopify", () => {
    expect(normalizeStorefrontDomain("")).toBeNull();
    expect(normalizeStorefrontDomain("localhost")).toBeNull();
    expect(normalizeStorefrontDomain("shop.myshopify.com")).toBeNull();
  });
});
