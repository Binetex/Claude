import { describe, it, expect } from "vitest";
import { toE164, normalizePhone } from "./phone";

describe("toE164 — нормализация американских форматов в E.164 (§16.14)", () => {
  it("разные форматы US → +13105551234", () => {
    for (const raw of ["(310) 555-1234", "310-555-1234", "+1 310 555 1234", "3105551234", "1 (310) 555 1234", "+13105551234"]) {
      expect(toE164(raw)).toBe("+13105551234");
    }
  });
  it("сохраняет уже-E.164 иностранный номер", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("мусор/пусто → null", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("abc")).toBeNull();
    expect(toE164("12")).toBeNull(); // слишком коротко
  });
  it("normalizePhone остаётся обратно совместимой", () => {
    expect(normalizePhone("(310) 555-1234")).toBe("+13105551234");
  });
});
