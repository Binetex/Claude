import { describe, it, expect } from "vitest";
import { itemHasVase, vaseTypeOf, consumablesForOrder, type ConsumableItemInput } from "./rules";

/** Все строки ниже — НАСТОЯЩИЕ названия позиций из боевой базы. */
const item = (name: string, over: Partial<ConsumableItemInput> = {}): ConsumableItemInput =>
  ({ name, variantName: null, quantity: 1, ...over });

describe("ваза в позиции заказа", () => {
  it("ваза отдельным товаром", () => {
    expect(itemHasVase(item("White Matte Glass Vase 8 in"))).toBe(true);
    expect(itemHasVase(item("Clear Glass Cylinder Vase 7 1/2 in"))).toBe(true);
  });

  it("ваза внутри названия букета", () => {
    expect(itemHasVase(item("Apricot & Vase - Clear Glass Vase 8 in"))).toBe(true);
    expect(itemHasVase(item("Bellgrass & Vase"))).toBe(true);
  });

  it("«No Vase» — это ОТСУТСТВИЕ вазы, хотя слово vase в строке есть", () => {
    expect(itemHasVase(item("Pink Floyd Roses - Standard, No Vase"))).toBe(false);
    expect(itemHasVase(item("White Roses - Standard, No Vase"))).toBe(false);
  });

  it("букет без вазы", () => {
    expect(itemHasVase(item("Ivory Silence"))).toBe(false);
    expect(itemHasVase(item("Meadowline - Standard"))).toBe(false);
  });

  it("границы слова: «Vase» внутри других слов не считается", () => {
    expect(itemHasVase(item("Vaseline gift set"))).toBe(false);
  });
});

describe("тип вазы", () => {
  it("крупная стеклянная проверяется РАНЬШЕ обычной", () => {
    expect(vaseTypeOf(item("Citrus Heights & Vase - Large Clear Glass Vase 7 in"))).toBe("LARGE_GLASS");
    expect(vaseTypeOf(item("Clear Glass Vase 8 in"))).toBe("CLEAR_GLASS");
    expect(vaseTypeOf(item("Clear Glass Cylinder Vase 7 1/2 in"))).toBe("CLEAR_GLASS");
  });

  it("остальные типы из таблицы владельца", () => {
    expect(vaseTypeOf(item("White Matte Glass Vase 8 in"))).toBe("WHITE_MATTE");
    expect(vaseTypeOf(item("Watercolor Sketch & Vase - Chocolate Matte Glass Vase"))).toBe("CHOCOLATE");
    expect(vaseTypeOf(item("Morning Dew & Vase - Sage Sculptural Vase 7 1/2 in"))).toBe("SAGE");
    expect(vaseTypeOf(item("Bluebird Kiss & Vase - Bud Vase 8 in"))).toBe("BUD");
    expect(vaseTypeOf(item("Mystical Powder - Textured Vase 11 in"))).toBe("TEXTURED");
  });

  it("тип берётся из каталога, когда в тексте его нет", () => {
    expect(vaseTypeOf(item("Bellgrass & Vase", { linkedVaseName: "Sage Sculptural Vase 7 1/2 in" }))).toBe("SAGE");
  });

  it("текст СИЛЬНЕЕ каталога: продано то, что написано в строке заказа", () => {
    const it0 = item("50 Scarlet Roses & Vase - Beige Sculptural Vase", { linkedVaseName: "Sage Sculptural Vase" });
    expect(vaseTypeOf(it0)).toBe("BEIGE");
  });

  it("у позиции без вазы типа нет", () => {
    expect(vaseTypeOf(item("Pink Floyd Roses - Standard, No Vase"))).toBeNull();
  });

  it("ваза есть, тип незнакомый — честный null, а не выдуманный тип", () => {
    expect(vaseTypeOf(item("Unicorn Vase 9 in"))).toBeNull();
  });
});

describe("расход по заказу", () => {
  it("букет без вазы в магазине со своей упаковкой: записка для БУКЕТА", () => {
    const r = consumablesForOrder({ items: [item("Ivory Silence")], storeHasBranding: true });
    expect(r).toMatchObject({ vaseCount: 0, vaseBottoms: 0, careGuide: "BOUQUET", brandedEnvelope: 1 });
  });

  it("букет с вазой: записка для ВАЗЫ и донышко", () => {
    const r = consumablesForOrder({ items: [item("Apricot & Vase - Clear Glass Vase 8 in")], storeHasBranding: true });
    expect(r).toMatchObject({ vaseCount: 1, vaseBottoms: 1, careGuide: "VASE" });
    expect(r.vasesByType.get("CLEAR_GLASS")).toBe(1);
  });

  it("магазин без своей упаковки: ни записки, ни брендированного конверта", () => {
    const r = consumablesForOrder({ items: [item("Clear Glass Vase 8 in")], storeHasBranding: false });
    expect(r).toMatchObject({ careGuide: null, brandedEnvelope: 0, vaseCount: 1 });
  });

  it("записка РОВНО ОДНА на заказ, даже если букетов в нём несколько", () => {
    const r = consumablesForOrder({
      items: [item("Ivory Silence"), item("Meadowline"), item("Bellgrass & Vase")],
      storeHasBranding: true,
    });
    expect(r.careGuide).toBe("VASE"); // есть ваза — значит вазная
    expect(r.brandedEnvelope).toBe(1);
  });

  it("две вазы в одной позиции считаются по количеству, а не по строке", () => {
    const r = consumablesForOrder({ items: [item("Clear Glass Vase 8 in", { quantity: 2 })], storeHasBranding: true });
    expect(r.vaseCount).toBe(2);
    expect(r.vaseBottoms).toBe(2);
    expect(r.vasesByType.get("CLEAR_GLASS")).toBe(2);
  });

  it("ваза с нераспознанным типом попадает в UNKNOWN, но донышко и записку получает", () => {
    const r = consumablesForOrder({ items: [item("Unicorn Vase 9 in")], storeHasBranding: true });
    expect(r.vasesByType.get("UNKNOWN")).toBe(1);
    expect(r.vaseBottoms).toBe(1);
    expect(r.careGuide).toBe("VASE");
  });
});
