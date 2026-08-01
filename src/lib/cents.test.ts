import { describe, it, expect } from "vitest";
import { usdToCents, centsToUsdInput, formatCents, CentsParseError } from "./cents";

describe("usdToCents", () => {
  it("разбирает обычные суммы", () => {
    expect(usdToCents("12")).toBe(1200);
    expect(usdToCents("12.5")).toBe(1250);
    expect(usdToCents("12.50")).toBe(1250);
    expect(usdToCents("0")).toBe(0);
    expect(usdToCents("0.05")).toBe(5);
    expect(usdToCents("1,234.50")).toBe(123450);
    expect(usdToCents(" 40.00 ")).toBe(4000);
  });

  it("пустая строка — это «не задано», а не ноль", () => {
    expect(usdToCents("")).toBeNull();
    expect(usdToCents("   ")).toBeNull();
  });

  it("отвергает мусор, минус и лишние знаки", () => {
    for (const bad of ["-1", "-0.01", "12.345", "abc", "12,5.5", "1,2,3", "1e3", "$12", "12."]) {
      expect(() => usdToCents(bad)).toThrow(CentsParseError);
    }
  });

  it("не теряет цент на дробях, где ломается float", () => {
    expect(usdToCents("0.29")).toBe(29);
    expect(usdToCents("1.15")).toBe(115);
    expect(usdToCents("19.99")).toBe(1999);
    // 1.005 * 100 в double даёт 100.49999999999999 — здесь такой ошибки быть не может.
    expect(usdToCents("1.00")).toBe(100);
  });
});

describe("обратное преобразование", () => {
  it("centsToUsdInput", () => {
    expect(centsToUsdInput(1200)).toBe("12.00");
    expect(centsToUsdInput(5)).toBe("0.05");
    expect(centsToUsdInput(0)).toBe("0.00");
    expect(centsToUsdInput(null)).toBe("");
  });

  it("formatCents отличает ноль от неизвестного", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1200)).toBe("$12.00");
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
  });

  it("round-trip не теряет значение", () => {
    for (const c of [0, 5, 99, 1200, 123450]) {
      expect(usdToCents(centsToUsdInput(c))).toBe(c);
    }
  });
});
