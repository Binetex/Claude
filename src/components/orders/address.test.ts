import { describe, it, expect } from "vitest";
import { recipientMapsUrl, recipientAddressLines } from "./address";

const query = (url: string) => decodeURIComponent(new URL(url).searchParams.get("query") ?? "");

/**
 * Одна ссылка на карту на всю систему. Раньше список заказов и карточка телеграма собирали её
 * сами и тянули в запрос квартиру: Google разбирал «South Le Doux Road, 302» не как дом на этой
 * улице, и по одному и тому же заказу из списка и из карточки открывались разные точки
 * (THEFLOW-20537).
 */
describe("ссылка на карту", () => {
  const addr = { addressLine: "South Le Doux Road", apartment: "302", city: "Los Angeles", zip: "90056" };

  it("квартира в запрос не попадает", () => {
    expect(query(recipientMapsUrl(addr))).toBe("South Le Doux Road, Los Angeles 90056");
  });

  it("лишние поля не оставляют пустых запятых", () => {
    expect(query(recipientMapsUrl({ addressLine: "1 Main St", city: null, zip: null }))).toBe("1 Main St");
    expect(query(recipientMapsUrl({ addressLine: "1 Main St", city: "LA", zip: null }))).toBe("1 Main St, LA");
  });

  it("а в тексте адреса квартира остаётся — её читает человек, а не геокодер", () => {
    expect(recipientAddressLines(addr)).toEqual(["South Le Doux Road, 302", "Los Angeles 90056"]);
  });
});
