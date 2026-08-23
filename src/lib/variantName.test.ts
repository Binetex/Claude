import { describe, it, expect } from "vitest";
import { displayVariantName } from "./variantName";

describe("имя варианта для показа", () => {
  it("настоящее название остаётся", () => {
    expect(displayVariantName("Deluxe")).toBe("Deluxe");
    expect(displayVariantName("  Standard  ")).toBe("Standard");
  });

  it("заглушка Shopify выбрасывается", () => {
    // Товар без вариаций: показывать эту строку человеку нельзя, она не название.
    expect(displayVariantName("Default Title")).toBeNull();
    expect(displayVariantName("default title")).toBeNull();
    expect(displayVariantName("Default")).toBeNull();
  });

  it("пустое и отсутствующее дают null, а не пустую строку", () => {
    expect(displayVariantName("")).toBeNull();
    expect(displayVariantName("   ")).toBeNull();
    expect(displayVariantName(null)).toBeNull();
    expect(displayVariantName(undefined)).toBeNull();
  });

  it("название, лишь содержащее слово Default, остаётся", () => {
    expect(displayVariantName("Default Blue Vase")).toBe("Default Blue Vase");
  });
});
