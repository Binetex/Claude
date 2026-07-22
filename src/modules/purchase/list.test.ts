import { describe, it, expect } from "vitest";
import { purchaseListToText, type PurchaseItem } from "@/modules/purchase/list";

describe("purchaseListToText — формат списка закупки", () => {
  const items: PurchaseItem[] = [
    { orderNumber: "O'HARA-1053", productName: "White Roses Bouquet", variantName: "Medium", quantity: 2, composition: "24 white roses\n5 eucalyptus stems\n1 vase", image: null },
    { orderNumber: "O'HARA-1054", productName: "Peony Dream", variantName: "Large", quantity: 1, composition: null, image: null },
  ];
  const text = purchaseListToText(items);

  it("включает номер заказа, товар, вариант и количество", () => {
    expect(text).toContain("O'HARA-1053");
    expect(text).toContain("White Roses Bouquet — Medium × 2");
  });

  it("выводит состав как есть (без объединения строк)", () => {
    expect(text).toContain("24 white roses");
    expect(text).toContain("5 eucalyptus stems");
  });

  it("для пустого snapshot показывает «Состав варианта не указан»", () => {
    expect(text).toContain("Состав варианта не указан");
  });

  it("не объединяет одинаковые строки разных товаров (оба заказа присутствуют отдельно)", () => {
    expect(text).toContain("O'HARA-1054");
    expect(text).toContain("Peony Dream — Large × 1");
  });
});
