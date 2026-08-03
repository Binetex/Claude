import { describe, it, expect } from "vitest";
import { computeDayFinance, computeOrderContribution, dayShareCents, type DayOrderInput } from "./dayCalc";

function order(id: string, over: Partial<DayOrderInput> = {}): DayOrderInput {
  return {
    orderId: id,
    orderNumber: id,
    siteId: "s1",
    grossRevenueCents: 18000, // 150 товары + 10 налог + 20 доставка
    customerTotalCents: 18000,
    tipCents: 0,
    taxCents: 1000,
    deliveryActualCents: 1200,
    acquiringFeeCents: 500,
    vaseGiftCostCents: 0,
    consumablesCents: 500,
    additionalCents: 0,
    feeFromActual: false,
    consumablesFromOverride: false,
    ...over,
  };
}

describe("вклад заказа", () => {
  it("считается как выручка минус собственные расходы", () => {
    const r = computeOrderContribution(order("a"));
    // 18000 − 0 чаевые − 1000 налог − 1200 доставка − 500 комиссия − 0 ваза − 500 расходники
    expect(r.contributionCents).toBe(14800);
    expect(r.missing).toHaveLength(0);
  });

  it("чаевые входят в выручку и тут же вычитаются — на итог не влияют", () => {
    const withTip = computeOrderContribution(order("a", { grossRevenueCents: 23000, tipCents: 5000 }));
    const withoutTip = computeOrderContribution(order("a"));
    expect(withTip.contributionCents).toBe(withoutTip.contributionCents);
  });

  it("дополнительный расход уменьшает вклад на полную сумму", () => {
    const base = computeOrderContribution(order("a"));
    const withExpense = computeOrderContribution(order("a", { additionalCents: 10000 }));
    expect(base.contributionCents - withExpense.contributionCents).toBe(10000);
  });

  it("неизвестный расход — это не ноль: заказ помечается неполным, вклад не считается", () => {
    for (const [field, code] of [
      ["deliveryActualCents", "DELIVERY_ACTUAL_COST"],
      ["acquiringFeeCents", "ACQUIRING_FEE"],
      ["vaseGiftCostCents", "VASE_GIFT_COST"],
      ["consumablesCents", "CONSUMABLES_RATE"],
    ] as const) {
      const r = computeOrderContribution(order("a", { [field]: null }));
      expect(r.missing).toContain(code);
      expect(r.contributionCents).toBe(0);
    }
  });

  it("подтверждённый ноль — валидный расход, а не отсутствие данных", () => {
    const r = computeOrderContribution(order("a", { deliveryActualCents: 0 }));
    expect(r.missing).toHaveLength(0);
    expect(r.contributionCents).toBe(16000);
  });
});

describe("итог дня", () => {
  it("дневная закупка вычитается ОДИН раз, а не раскладывается по заказам", () => {
    const day = computeDayFinance([order("a"), order("b")], 6000);
    // (14800 + 14800) − 6000
    expect(day.distributableCents).toBe(23600);
    expect(day.flowerPurchaseCents).toBe(6000);
    expect(day.complete).toBe(true);
  });

  it("итог не зависит от того, как заказы распределены между собой", () => {
    // Раньше закупка делилась пропорционально «цветочной выручке», и итог мог зависеть
    // от классификации каталога. Теперь состав заказов на сумму дня не влияет.
    const even = computeDayFinance([order("a"), order("b")], 6000);
    const skewed = computeDayFinance(
      [order("a", { grossRevenueCents: 30000 }), order("b", { grossRevenueCents: 6000 })],
      6000
    );
    expect(even.grossRevenueCents).toBe(skewed.grossRevenueCents);
    expect(even.distributableCents).toBe(skewed.distributableCents);
  });

  it("нет дневной закупки — день не считается", () => {
    const day = computeDayFinance([order("a")], null);
    expect(day.blockers).toContain("DAILY_FLOWER_EXPENSE_MISSING");
    expect(day.complete).toBe(false);
    expect(day.distributableCents).toBe(0);
  });

  it("незаполненный заказ останавливает весь день", () => {
    const day = computeDayFinance([order("a"), order("b", { consumablesCents: null })], 6000);
    expect(day.blockers).toContain("ORDER_DATA_INCOMPLETE");
    expect(day.complete).toBe(false);
    expect(day.distributableCents).toBe(0);
    // При этом видно, чего именно не хватает — на этом держится очередь заполнения.
    expect(day.orders.find((o) => o.orderId === "b")!.missing).toContain("CONSUMABLES_RATE");
  });

  it("суммы строк собираются даже у неполного дня — их показывают, но не начисляют", () => {
    const day = computeDayFinance([order("a"), order("b", { consumablesCents: null })], 6000);
    expect(day.grossRevenueCents).toBe(36000);
    expect(day.distributableCents).toBe(0);
  });

  it("день без заказов не считается", () => {
    const day = computeDayFinance([], 6000);
    expect(day.complete).toBe(false);
    expect(day.distributableCents).toBe(0);
  });

  it("убыточный день даёт минус, а не ноль", () => {
    const day = computeDayFinance([order("a")], 50000);
    expect(day.distributableCents).toBeLessThan(0);
  });
});

describe("доля флориста", () => {
  it("66.6% от прибыли дня", () => {
    expect(dayShareCents(38952, 6660)).toBe(25942);
  });

  it("убыток не превращается в отрицательную выплату", () => {
    expect(dayShareCents(-5000, 6660)).toBe(0);
    expect(dayShareCents(0, 6660)).toBe(0);
  });

  it("убыточный заказ гасится прибыльными того же дня, а не выбрасывается", () => {
    const day = computeDayFinance(
      [order("a"), order("b", { grossRevenueCents: 2000, additionalCents: 10000 })],
      2000
    );
    // Второй заказ глубоко в минусе, но день в целом ещё прибыльный.
    expect(day.orders[1].contributionCents).toBeLessThan(0);
    expect(dayShareCents(day.distributableCents, 6660)).toBeGreaterThan(0);
  });
});
