/**
 * Арифметика распределяемой прибыли. Главное, что здесь закреплено: знаменатель
 * распределения не сжимается из-за проблемных заказов, а чаевые не попадают в деньги
 * флориста ни одним путём.
 */
import { describe, it, expect } from "vitest";
import {
  allocateFlowerExpense,
  computeDay,
  computeOrderSnapshot,
  flowerRevenueCents,
  primaryShareCents,
  type OrderCalcInput,
  type SnapshotItem,
} from "./calc";

const flower = (cents: number, qty = 1): SnapshotItem => ({
  id: `f${cents}`,
  name: "Bouquet",
  quantity: qty,
  unitPriceCents: cents,
  financialType: "FLOWER_PRODUCT",
  isTip: false,
});
const vase = (cents: number): SnapshotItem => ({
  id: `v${cents}`,
  name: "Vase",
  quantity: 1,
  unitPriceCents: cents,
  financialType: "VASE",
  isTip: false,
});
const tip = (cents: number): SnapshotItem => ({
  id: `t${cents}`,
  name: "Tip",
  quantity: 1,
  unitPriceCents: cents,
  financialType: null,
  isTip: true,
});
const unknown = (cents: number): SnapshotItem => ({
  id: `u${cents}`,
  name: "Custom item",
  quantity: 1,
  unitPriceCents: cents,
  financialType: null,
  isTip: false,
});

function order(id: string, over: Partial<OrderCalcInput> = {}): OrderCalcInput {
  return {
    orderId: id,
    orderNumber: id,
    siteId: "s1",
    deliveryDay: "2026-07-28",
    itemsTotalCents: 15000,
    taxCents: 1000,
    tipCents: 0,
    deliveryCustomerCents: 2000,
    customerPaidCents: 18000,
    items: [flower(15000)],
    deliveryActualCents: 1200,
    acquiringFee: { cents: 500, source: "ESTIMATED", modelId: "m1" },
    vaseGiftCostCents: 0,
    consumables: { cents: 500, source: "RATE", rateId: "r1" },
    otherExpenseCents: 0,
    ...over,
  };
}

describe("цветочная выручка", () => {
  it("считает только позиции-цветы", () => {
    expect(flowerRevenueCents([flower(10000), vase(3000)])).toBe(10000);
  });

  it("чаевые не входят и не мешают", () => {
    expect(flowerRevenueCents([flower(10000), tip(2000)])).toBe(10000);
  });

  it("две одинаковые позиции считаются по количеству", () => {
    expect(flowerRevenueCents([flower(5000, 3)])).toBe(15000);
  });

  it("позиция без связи с каталогом делает выручку неопределимой, а не нулевой", () => {
    expect(flowerRevenueCents([flower(10000), unknown(500)])).toBeNull();
  });
});

describe("распределение дневной закупки", () => {
  it("делится пропорционально цветочной выручке", () => {
    const a = allocateFlowerExpense(12000, [
      { orderId: "a", flowerRevenueCents: 10000 },
      { orderId: "b", flowerRevenueCents: 20000 },
      { orderId: "c", flowerRevenueCents: 30000 },
    ])!;
    expect(a.get("a")).toBe(2000);
    expect(a.get("b")).toBe(4000);
    expect(a.get("c")).toBe(6000);
  });

  it("ни один цент не теряется и не появляется", () => {
    const a = allocateFlowerExpense(10000, [
      { orderId: "a", flowerRevenueCents: 3333 },
      { orderId: "b", flowerRevenueCents: 3333 },
      { orderId: "c", flowerRevenueCents: 3334 },
    ])!;
    expect([...a.values()].reduce((x, y) => x + y, 0)).toBe(10000);
  });

  it("результат детерминирован при равных остатках", () => {
    const run = () =>
      [...allocateFlowerExpense(10, [
        { orderId: "b", flowerRevenueCents: 100 },
        { orderId: "a", flowerRevenueCents: 100 },
        { orderId: "c", flowerRevenueCents: 100 },
      ])!.entries()].sort();
    expect(run()).toEqual(run());
  });

  it("нулевой знаменатель при ненулевой закупке распределить нельзя", () => {
    expect(allocateFlowerExpense(5000, [{ orderId: "a", flowerRevenueCents: 0 }])).toBeNull();
  });
});

describe("расчёт заказа", () => {
  it("чаевые входят в выручку и тут же вычитаются отдельной строкой", () => {
    const r = computeOrderSnapshot(order("o1", { tipCents: 5000, items: [flower(15000), tip(5000)] }), 3000);
    // 150.00 товары + 10.00 налог + 20.00 доставка + 50.00 чаевые = 230.00 — ровно столько
    // заплатил клиент, поэтому строку можно сверить с суммой заказа на платформе.
    expect(r.grossRevenueCents).toBe(23000);
    expect(r.tipsCents).toBe(5000);
  });

  it("чаевые не меняют распределяемую прибыль ни на цент", () => {
    const withTip = computeOrderSnapshot(order("o1", { tipCents: 5000, items: [flower(15000), tip(5000)] }), 3000);
    const withoutTip = computeOrderSnapshot(order("o1"), 3000);
    // Представление изменилось, деньги — нет: чаевые вошли в верхнюю строку и вышли
    // расходом в том же размере.
    expect(withTip.distributableCents).toBe(withoutTip.distributableCents);
    expect(withTip.grossRevenueCents - withTip.tipsCents).toBe(withoutTip.grossRevenueCents);
  });

  it("налог входит в выручку и целиком вычитается — база флориста", () => {
    const r = computeOrderSnapshot(order("o1"), 3000);
    // 18000 − 1000 налог − 1200 доставка − 500 комиссия − 0 ваза − 500 расходники − 3000 цветы
    expect(r.distributableCents).toBe(11800);
    expect(r.isCalculable).toBe(true);
  });

  it("владелец вычитает только свою долю налога", () => {
    const florist = computeOrderSnapshot(order("o1"), 3000, 10000);
    const owner = computeOrderSnapshot(order("o1"), 3000, 2000); // 20%
    expect(owner.distributableCents - florist.distributableCents).toBe(800);
  });

  it("любой неизвестный расход исключает заказ, а прибыль обнуляется", () => {
    const r = computeOrderSnapshot(order("o1", { deliveryActualCents: null }), 3000);
    expect(r.isCalculable).toBe(false);
    expect(r.missing).toContain("DELIVERY_ACTUAL_COST");
    expect(r.distributableCents).toBe(0);
  });

  it("исключённый заказ удерживает свою долю закупки", () => {
    const r = computeOrderSnapshot(order("o1", { acquiringFee: null }), 3000);
    expect(r.isCalculable).toBe(false);
    expect(r.allocatedFlowerCents).toBe(3000);
  });

  it("убыточный заказ показывается минусом, а не нулём", () => {
    const r = computeOrderSnapshot(order("o1", { deliveryActualCents: 30000 }), 3000);
    expect(r.distributableCents).toBeLessThan(0);
  });
});

describe("расчёт дня", () => {
  it("проблемный заказ не увеличивает расходы исправных", () => {
    const orders = [
      order("a", { items: [flower(10000)], itemsTotalCents: 10000 }),
      order("b", { items: [flower(20000)], itemsTotalCents: 20000 }),
      order("c", { items: [flower(30000)], itemsTotalCents: 30000, deliveryActualCents: null }),
    ];
    const day = computeDay("2026-07-28", orders, 12000);

    // Знаменатель полный: 600.00, поэтому доли те же, что были бы без проблемы.
    expect(day.denominatorCents).toBe(60000);
    expect(day.orders.find((o) => o.orderId === "a")!.allocatedFlowerCents).toBe(2000);
    expect(day.orders.find((o) => o.orderId === "b")!.allocatedFlowerCents).toBe(4000);

    // Доля проблемного осталась нераспределённой.
    expect(day.allocatedCents).toBe(6000);
    expect(day.unallocatedCents).toBe(6000);
    expect(day.allocatedCents + day.unallocatedCents).toBe(12000);
  });

  it("исправление проблемного заказа не меняет доли остальных", () => {
    const base = [
      order("a", { items: [flower(10000)], itemsTotalCents: 10000 }),
      order("b", { items: [flower(20000)], itemsTotalCents: 20000 }),
    ];
    const broken = computeDay("2026-07-28", [...base, order("c", { items: [flower(30000)], itemsTotalCents: 30000, acquiringFee: null })], 12000);
    const fixed = computeDay("2026-07-28", [...base, order("c", { items: [flower(30000)], itemsTotalCents: 30000 })], 12000);

    for (const id of ["a", "b"]) {
      expect(fixed.orders.find((o) => o.orderId === id)!.allocatedFlowerCents).toBe(
        broken.orders.find((o) => o.orderId === id)!.allocatedFlowerCents
      );
      expect(fixed.orders.find((o) => o.orderId === id)!.distributableCents).toBe(
        broken.orders.find((o) => o.orderId === id)!.distributableCents
      );
    }
    expect(fixed.unallocatedCents).toBe(0);
  });

  it("нет дневной закупки — блокируется весь день", () => {
    const day = computeDay("2026-07-28", [order("a")], null);
    expect(day.blockers).toContain("DAILY_FLOWER_EXPENSE_MISSING");
    expect(day.orders.every((o) => !o.isCalculable)).toBe(true);
  });

  it("неопределимая выручка одного заказа блокирует весь день", () => {
    const day = computeDay("2026-07-28", [order("a"), order("b", { items: [flower(10000), unknown(500)] })], 12000);
    expect(day.blockers).toContain("FLOWER_REVENUE_UNDETERMINED");
    // Ни один заказ дня не считается: знаменатель недостоверен.
    expect(day.orders.every((o) => !o.isCalculable)).toBe(true);
  });

  it("нулевая цветочная выручка при ненулевой закупке — тоже блокер дня", () => {
    const day = computeDay("2026-07-28", [order("a", { items: [vase(5000)], itemsTotalCents: 5000 })], 12000);
    expect(day.blockers).toContain("FLOWER_REVENUE_UNDETERMINED");
  });

  it("незаполненный заказ останавливает весь день, а не выпадает из него", () => {
    const day = computeDay(
      "2026-07-28",
      [order("a", { items: [flower(10000)], itemsTotalCents: 10000 }), order("b", { items: [flower(10000)], itemsTotalCents: 10000, consumables: null })],
      2000
    );
    // Раньше день считался по одному заказу «a», а потом менялся, когда доезжали данные
    // по «b». Теперь суммы нет вовсе, пока день не заполнен целиком.
    expect(day.blockers).toContain("ORDER_DATA_INCOMPLETE");
    expect(day.distributableTotalCents).toBe(0);
    // При этом видно, чего именно не хватает: очередь заполнения на этом и держится.
    expect(day.orders.find((o) => o.orderId === "b")!.missing).toContain("CONSUMABLES_RATE");
  });

  it("полный день считается как сумма своих заказов", () => {
    const day = computeDay(
      "2026-07-28",
      [order("a", { items: [flower(10000)], itemsTotalCents: 10000 }), order("b", { items: [flower(10000)], itemsTotalCents: 10000 })],
      2000
    );
    expect(day.blockers).toHaveLength(0);
    expect(day.distributableTotalCents).toBe(day.orders.reduce((a, o) => a + o.distributableCents, 0));
  });
});

describe("доля основного флориста", () => {
  it("66.6% считаются в базисных пунктах", () => {
    expect(primaryShareCents(100000, 6660)).toBe(66600);
  });

  it("убыточный день не создаёт отрицательного начисления", () => {
    expect(primaryShareCents(-5000, 6660)).toBe(0);
  });

  it("убыток одного заказа гасится прибылью другого в том же дне", () => {
    const day = computeDay(
      "2026-07-28",
      [
        order("a", { items: [flower(50000)], itemsTotalCents: 50000 }),
        order("b", { items: [flower(1000)], itemsTotalCents: 1000, deliveryActualCents: 9000 }),
      ],
      1000
    );
    expect(day.distributableTotalCents).toBeGreaterThan(0);
    expect(primaryShareCents(day.distributableTotalCents, 6660)).toBeGreaterThan(0);
  });
});
