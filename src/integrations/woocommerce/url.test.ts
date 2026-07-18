import { describe, it, expect } from "vitest";
import { normalizeStoreUrl } from "./url";

describe("normalizeStoreUrl (сценарий 1)", () => {
  it("нормализует корень + собирает apiBaseUrl, убирает trailing slash", () => {
    const r = normalizeStoreUrl("https://example.com/");
    expect(r).toEqual({ ok: true, storeUrl: "https://example.com", apiBaseUrl: "https://example.com/wp-json/wc/v3", apiVersion: "wc/v3" });
  });

  it("допускает www и подкаталог установки", () => {
    expect(normalizeStoreUrl("https://www.example.com")).toMatchObject({ ok: true, storeUrl: "https://www.example.com" });
    expect(normalizeStoreUrl("https://example.com/shop/")).toMatchObject({ ok: true, apiBaseUrl: "https://example.com/shop/wp-json/wc/v3" });
  });

  it("требует HTTPS", () => {
    expect(normalizeStoreUrl("http://example.com")).toMatchObject({ ok: false });
  });

  it("отвергает готовый /wp-json endpoint (не дублируем)", () => {
    expect(normalizeStoreUrl("https://example.com/wp-json/wc/v3")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("https://example.com/wp-json/")).toMatchObject({ ok: false });
  });

  it("отвергает admin-страницу", () => {
    expect(normalizeStoreUrl("https://example.com/wp-admin")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("https://example.com/wp-login.php")).toMatchObject({ ok: false });
  });

  it("отвергает credentials/query/hash в URL", () => {
    expect(normalizeStoreUrl("https://user:pass@example.com")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("https://example.com/?a=1")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("https://example.com/#x")).toMatchObject({ ok: false });
  });

  it("отвергает мусор и пустое", () => {
    expect(normalizeStoreUrl("")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("not a url")).toMatchObject({ ok: false });
    expect(normalizeStoreUrl("https://localhost")).toMatchObject({ ok: false }); // нет точки в домене
  });

  it("валидирует версию API", () => {
    expect(normalizeStoreUrl("https://example.com", "wc/v9")).toMatchObject({ ok: true, apiVersion: "wc/v9" });
    expect(normalizeStoreUrl("https://example.com", "bad")).toMatchObject({ ok: false });
  });
});
