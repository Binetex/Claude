import { describe, it, expect } from "vitest";
import { TAX_POLICY_ALWAYS, ownerTaxChange, taxShareOn, taxPolicyUntil, taxTotalsByPolicy, type TaxPolicyRow } from "./taxPolicyPeriods";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const rows: TaxPolicyRow[] = [
  { siteId: null, actualShareBp: 1200, effectiveFrom: TAX_POLICY_ALWAYS },
  { siteId: null, actualShareBp: 2000, effectiveFrom: d("2026-10-01") },
  { siteId: "jf", actualShareBp: 500, effectiveFrom: d("2026-09-15") },
];

describe("налог владельца по дням", () => {
  it("новая ставка с даты не трогает дни до неё", () => {
    expect(taxShareOn(rows, "theflow", d("2026-09-30"))).toBe(1200);
    expect(taxShareOn(rows, "theflow", d("2026-10-01"))).toBe(2000);
  });

  it("своя ставка магазина главнее общей, но только с её даты", () => {
    expect(taxShareOn(rows, "jf", d("2026-09-14"))).toBe(1200);
    expect(taxShareOn(rows, "jf", d("2026-09-15"))).toBe(500);
    expect(taxShareOn(rows, "jf", d("2026-10-05"))).toBe(500);
  });

  it("ставки нет — налог расходом целиком", () => {
    expect(taxShareOn([{ siteId: null, actualShareBp: 2000, effectiveFrom: d("2026-10-01") }], "x", d("2026-09-01"))).toBe(10000);
  });

  it("период кончается днём перед следующей ставкой той же области", () => {
    expect(taxPolicyUntil(rows, rows[0])).toEqual(d("2026-09-30"));
    expect(taxPolicyUntil(rows, rows[1])).toBeNull();
    expect(taxPolicyUntil(rows, rows[2])).toBeNull();
  });
});

describe("налог по периодам в долларах", () => {
  it("заказ идёт в ту ставку, что действовала в его день; вычет округляется по заказу", () => {
    const withIds = rows.map((r, i) => ({ ...r, id: `p${i}` }));
    const totals = taxTotalsByPolicy(withIds, [
      { siteId: "theflow", deliveryDate: d("2026-09-30"), taxCents: 1999 }, // 12% → 239.88 → 240
      { siteId: "theflow", deliveryDate: d("2026-10-01"), taxCents: 1000 }, // 20% → 200
      { siteId: "jf", deliveryDate: d("2026-09-20"), taxCents: 1000 }, // своя 5% → 50
    ]);
    expect(totals.get("p0")).toEqual({ orders: 1, collectedCents: 1999, deductedCents: 240 });
    expect(totals.get("p1")).toEqual({ orders: 1, collectedCents: 1000, deductedCents: 200 });
    expect(totals.get("p2")).toEqual({ orders: 1, collectedCents: 1000, deductedCents: 50 });
  });
});

describe("предварительный расчёт налогового расхода", () => {
  const orders = [
    { siteId: "theflow", deliveryDate: d("2026-08-10"), taxCents: 1000 },
    { siteId: "theflow", deliveryDate: d("2026-09-10"), taxCents: 2000 },
    { siteId: "theflow", deliveryDate: d("2026-10-03"), taxCents: 500 },
  ];

  it("новая ставка задним числом с 1 сентября: задеты сентябрь, но не август и не октябрь со своей ставкой", () => {
    const after = [...rows, { siteId: null, actualShareBp: 2000, effectiveFrom: d("2026-09-01") }];
    expect(ownerTaxChange(rows, after, orders)).toEqual({
      orders: 1, collectedCents: 2000, beforeCents: 240, afterCents: 400, deltaCents: 160, fromDay: "2026-09-10", toDay: "2026-09-10",
    });
  });

  it("ничего не меняется — ни одного задетого заказа", () => {
    expect(ownerTaxChange(rows, rows, orders)).toMatchObject({ orders: 0, deltaCents: 0, fromDay: null });
  });
});
