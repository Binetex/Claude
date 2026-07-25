import { describe, it, expect } from "vitest";
import { computeEstimatedProfit } from "./profit";

/** Пустой заказ — база, поверх которой меняем по одному полю. */
const base = {
  itemsTotal: 0, tax: 0, tip: 0, deliveryCustomerCost: 0,
  floristTotal: 0, deliveryActualCost: 0,
};

describe("примерная прибыль владельца", () => {
  it("доход клиента минус наши расходы", () => {
    // Товары 100 + налог 9 + чаевые 20 + доставка с клиента 14 = 143 дохода;
    // флористу 60 + доставка по факту 12 = 72 расхода.
    expect(computeEstimatedProfit({
      ...base, itemsTotal: 100, tax: 9, tip: 20, deliveryCustomerCost: 14,
      floristTotal: 60, deliveryActualCost: 12,
    })).toBe(71);
  });

  it("«Доставка (заказчик)» УВЕЛИЧИВАЕТ прибыль, а не уменьшает", () => {
    const without = computeEstimatedProfit({ ...base, itemsTotal: 100, floristTotal: 60 });
    const with14 = computeEstimatedProfit({ ...base, itemsTotal: 100, floristTotal: 60, deliveryCustomerCost: 14 });
    expect(with14 - without).toBe(14);
  });

  it("«Доставка (факт)» уменьшает прибыль", () => {
    const without = computeEstimatedProfit({ ...base, itemsTotal: 100, floristTotal: 60 });
    const with12 = computeEstimatedProfit({ ...base, itemsTotal: 100, floristTotal: 60, deliveryActualCost: 12 });
    expect(without - with12).toBe(12);
  });

  it("чаевые целиком идут в прибыль", () => {
    expect(computeEstimatedProfit({ ...base, tip: 25 })).toBe(25);
  });

  it("налог включён в доход (решение владельца)", () => {
    expect(computeEstimatedProfit({ ...base, tax: 9.5 })).toBe(9.5);
  });

  it("обе доставки вместе: заработали на доставке 2 доллара", () => {
    expect(computeEstimatedProfit({ ...base, deliveryCustomerCost: 14, deliveryActualCost: 12 })).toBe(2);
  });

  it("доставка себе в убыток даёт минус", () => {
    expect(computeEstimatedProfit({ ...base, deliveryCustomerCost: 10, deliveryActualCost: 25 })).toBe(-15);
  });

  it("цена флориста выше выручки → отрицательная прибыль видна, а не обнуляется", () => {
    expect(computeEstimatedProfit({ ...base, itemsTotal: 50, floristTotal: 80 })).toBe(-30);
  });

  it("копейки не накапливают погрешность double", () => {
    // 0.1 + 0.2 в double даёт 0.30000000000000004 — округление до центов это убирает.
    expect(computeEstimatedProfit({ ...base, itemsTotal: 0.1, tax: 0.2 })).toBe(0.3);
    expect(computeEstimatedProfit({ ...base, itemsTotal: 239.21, tip: 0, floristTotal: 100.07 })).toBe(139.14);
  });

  it("пустой заказ — ноль", () => {
    expect(computeEstimatedProfit(base)).toBe(0);
  });
});

describe("реальные заказы (числа с прода)", () => {
  it("#20303: Afterpay 239.21, доставка клиента 0, флористу 0 — вся сумма в прибыль", () => {
    expect(computeEstimatedProfit({ ...base, itemsTotal: 239.21 })).toBe(239.21);
  });

  it("старая формула занижала прибыль ровно на доставку клиента и налог", () => {
    const parts = {
      ...base, itemsTotal: 187.4, tax: 17.2, tip: 30, deliveryCustomerCost: 14,
      floristTotal: 90, deliveryActualCost: 11.5,
    };
    const old = parts.itemsTotal - parts.floristTotal - parts.deliveryActualCost + parts.tip; // как было
    const now = computeEstimatedProfit(parts);
    expect(Math.round((now - old) * 100) / 100).toBe(parts.deliveryCustomerCost + parts.tax);
  });
});
