import { describe, it, expect } from "vitest";
import { isTipItem, compensableItems, tipFloristAmount, effectiveFloristTotal } from "./serviceItems";
import { computeEstimatedProfit } from "./profit";

/**
 * Правило одно: чаевые целиком принадлежат владельцу и никогда не входят в заработок и долг
 * флориста. Данные в тестах — реальная форма заказа FLWBR-91157 (Shopify): букет, служебная
 * позиция «Personal Note», и чаевые отдельной строкой без связи с каталогом.
 */

const bouquet = { name: "Ranunculus & Hydrangea Refined Bloom Bouquet", productId: "p1", variantId: "v1", floristItemPrice: 118 };
const tipItem = { name: "Tip", productId: null, variantId: null, floristItemPrice: 17 };

describe("распознавание позиции-чаевых", () => {
  it("Shopify-строка чаевых (без связи с каталогом) — служебная", () => {
    expect(isTipItem(tipItem)).toBe(true);
    expect(isTipItem({ name: "  tip ", productId: null, variantId: null })).toBe(true);
    expect(isTipItem({ name: "Gratuity", productId: null, variantId: null })).toBe(true);
    expect(isTipItem({ name: "Чаевые", productId: null, variantId: null })).toBe(true);
  });

  it("обычный товар со словом tip в названии служебным НЕ становится", () => {
    expect(isTipItem({ name: "Tulip Tips Bouquet", productId: "p9", variantId: "v9" })).toBe(false);
    // Даже без связи с каталогом: имя сравнивается целиком, а не подстрокой.
    expect(isTipItem({ name: "Tulip Tips Bouquet", productId: null, variantId: null })).toBe(false);
    expect(isTipItem({ name: "Tip Top Roses", productId: null, variantId: null })).toBe(false);
  });

  it("позиция, сопоставленная с каталогом, служебной не считается даже с именем Tip", () => {
    expect(isTipItem({ name: "Tip", productId: "p1", variantId: null })).toBe(false);
    expect(isTipItem({ name: "Tip", productId: null, variantId: "v1" })).toBe(false);
  });
});

describe("цена флориста", () => {
  it("товар 169 / флорист 118 + чаевые 17 → флористу 118", () => {
    const items = [bouquet, tipItem];
    // Снимок в БД у старого заказа включал чаевые: 118 + 17.
    expect(effectiveFloristTotal(135, items)).toBe(118);
    expect(compensableItems(items)).toEqual([bouquet]);
  });

  it("чаевые, импортированные отдельной Shopify-позицией, не дают цену флориста", () => {
    // Фолбэк «цена не задана → полная стоимость клиента» к служебной строке не применяется:
    // она вообще не попадает в набор оплачиваемых позиций.
    const shopifyTip = { name: "Tip", productId: null, variantId: null, floristItemPrice: 0 };
    expect(compensableItems([bouquet, shopifyTip])).toEqual([bouquet]);
    expect(effectiveFloristTotal(118, [bouquet, shopifyTip])).toBe(118);
  });

  it("старый заказ с ошибочно сохранённым floristItemPrice у Tip пересчитывается верно", () => {
    expect(tipFloristAmount([bouquet, tipItem])).toBe(17);
    expect(effectiveFloristTotal(135, [bouquet, tipItem])).toBe(118);
    // Новый заказ: у чаевых уже 0, поправка ничего не меняет.
    expect(effectiveFloristTotal(118, [bouquet, { ...tipItem, floristItemPrice: 0 }])).toBe(118);
  });

  it("заказ, где кроме чаевых ничего не оплачивается, даёт ноль, а не минус", () => {
    expect(effectiveFloristTotal(17, [tipItem])).toBe(0);
  });

  it("ручную сумму владельца не пересчитываем: она не собрана из снимков позиций", () => {
    // Снимки дают 135.00, а владелец задал 130.00 — что он в неё заложил, из данных не видно.
    expect(effectiveFloristTotal(130, [bouquet, tipItem])).toBe(130);
    // Совпала со снимками (типичный случай «ручная = авто») — чаевые заведомо внутри, вычитаем.
    expect(effectiveFloristTotal(135, [bouquet, tipItem])).toBe(118);
  });
});

describe("прибыль владельца", () => {
  // Реальные суммы FLWBR-91157: itemsTotal не включает чаевые (у Shopify tip вне subtotal).
  const parts = { itemsTotal: 170, tax: 17.75, tip: 17, deliveryCustomerCost: 15, deliveryActualCost: 14.49 };
  // Полный состав заказа: записка 1.00/0.70 + букет 169.00/118.30 + чаевые 17.00 → снимок 136.00.
  const realItems = [
    { name: "Personal Note + Envelope", productId: "p2", variantId: "v2", floristItemPrice: 0.7 },
    { ...bouquet, floristItemPrice: 118.3 },
    tipItem,
  ];

  it("прибыль растёт ровно на сумму чаевых, снятых с флориста", () => {
    const before = computeEstimatedProfit({ ...parts, floristTotal: 136 });
    const after = computeEstimatedProfit({ ...parts, floristTotal: effectiveFloristTotal(136, realItems) });
    expect(before).toBe(69.26);
    expect(after).toBe(86.26);
    expect(Math.round((after - before) * 100) / 100).toBe(17);
  });

  it("чаевые не учитываются дважды, когда есть и позиция, и Order.tip", () => {
    // Доход: товары + налог + чаевые + доставка. Чаевые входят ровно один раз — как Order.tip;
    // позиция-чаевые в itemsTotal не входит и цену флориста не создаёт.
    const floristTotal = effectiveFloristTotal(136, realItems);
    expect(floristTotal).toBe(119); // 0.70 + 118.30, чаевые сняты
    const income = parts.itemsTotal + parts.tax + parts.tip + parts.deliveryCustomerCost;
    expect(income).toBe(219.75); // ровно customerTotal заказа
    expect(computeEstimatedProfit({ ...parts, floristTotal })).toBe(
      Math.round((income - floristTotal - parts.deliveryActualCost) * 100) / 100
    );
  });
});
