import { describe, it, expect } from "vitest";
import { pickLocation, pickedReviewUrl, normalizeZip, type PickableLocation } from "./locationPick";

const loc = (over: Partial<PickableLocation> = {}): PickableLocation => ({
  id: "l1",
  name: "Beverly Hills",
  reviewUrl: "https://g.page/r/bh/review",
  zips: ["90210"],
  isDefault: false,
  isActive: true,
  ...over,
});

describe("нормализация ZIP", () => {
  it("ZIP+4 и пробелы приводятся к пяти цифрам", () => {
    // В заказах встречается «90056-1234»; без этого адрес не нашёл бы свою точку.
    expect(normalizeZip(" 90056-1234 ")).toBe("90056");
    expect(normalizeZip("90056")).toBe("90056");
  });

  it("мусор и пустота дают пустую строку, а не подобие ZIP", () => {
    for (const junk of ["", "   ", "—", null, undefined]) expect(normalizeZip(junk)).toBe("");
  });
});

describe("выбор точки", () => {
  it("ZIP совпал — берём эту точку", () => {
    const res = pickLocation("90210", [loc(), loc({ id: "l2", zips: ["90056"] })], null);
    expect(res).toMatchObject({ ok: true, reason: "zip" });
    expect(pickedReviewUrl(res)).toBe("https://g.page/r/bh/review");
  });

  it("ZIP+4 в заказе находит точку, размеченную пятизначным ZIP", () => {
    const res = pickLocation("90210-4021", [loc()], null);
    expect(res).toMatchObject({ ok: true, reason: "zip" });
  });

  it("ZIP не нашёлся — берём запасную точку магазина", () => {
    const fallback = loc({ id: "l2", name: "Ladera", zips: [], isDefault: true, reviewUrl: "https://g.page/r/ld/review" });
    const res = pickLocation("99999", [loc(), fallback], null);
    expect(res).toMatchObject({ ok: true, reason: "default" });
    expect(pickedReviewUrl(res)).toBe("https://g.page/r/ld/review");
  });

  it("выключенная точка не достаётся заказу, даже если её ZIP совпал", () => {
    const res = pickLocation("90210", [loc({ isActive: false })], "https://site/review");
    expect(res).toMatchObject({ ok: true, reason: "site_fallback" });
  });

  it("точек нет — работает старая ссылка магазина", () => {
    // Она кормит живые рассылки; пока справочник не заполнен, заказ всё равно получит ссылку.
    const res = pickLocation("90210", [], "https://site/review");
    expect(res).toMatchObject({ ok: true, reason: "site_fallback" });
    expect(pickedReviewUrl(res)).toBe("https://site/review");
  });

  it("нет ни точек, ни старой ссылки — честный отказ, а не пустая строка", () => {
    const res = pickLocation("90210", [], null);
    expect(res).toEqual({ ok: false, error: "no_location" });
    expect(pickedReviewUrl(res)).toBeNull();
  });

  it("пустой ZIP заказа уводит к запасной точке, а не к первой попавшейся", () => {
    const first = loc({ id: "l1", zips: ["90210"] });
    const fallback = loc({ id: "l2", zips: [], isDefault: true });
    expect(pickLocation("", [first, fallback], null)).toMatchObject({ ok: true, reason: "default", location: { id: "l2" } });
  });

  it("ZIP важнее запасной точки, даже если запасная идёт первой в списке", () => {
    const fallback = loc({ id: "l2", zips: [], isDefault: true });
    const byZip = loc({ id: "l1", zips: ["90056"] });
    expect(pickLocation("90056", [fallback, byZip], null)).toMatchObject({ reason: "zip", location: { id: "l1" } });
  });
});
