import { describe, it, expect } from "vitest";
import { isUberProvider, pickCostCents, centsToDollars, decideCostUpdate } from "./costCapture";

describe("isUberProvider", () => {
  it("имя uber (регистронезависимо, с пробелами) → true", () => {
    expect(isUberProvider("uber", null)).toBe(true);
    expect(isUberProvider("Uber", null)).toBe(true);
    expect(isUberProvider("  UBER ", null)).toBe(true);
  });
  it("другой провайдер → false", () => {
    expect(isUberProvider("doordash", null)).toBe(false);
    expect(isUberProvider("roadie", "prov_x")).toBe(false);
    expect(isUberProvider(null, null)).toBe(false);
  });

  it("регрессия PAR-1308: стабильный provider.id 'dsp_19g67ldj7ek3j' И имя 'Uber' → true; покоштучный del_ → нет", () => {
    // Реальные значения: provider={id:'dsp_19g67ldj7ek3j', name:'Uber'} → в наш формат: name+stableId.
    expect(isUberProvider("Uber", "dsp_19g67ldj7ek3j")).toBe(true); // и по имени, и по id
    expect(isUberProvider(null, "dsp_19g67ldj7ek3j")).toBe(true); // по стабильному id (без имени)
    expect(isUberProvider("Uber", null)).toBe(true); // по имени (форма GET, без stable id)
    // Покоштучный del_ id (это НЕ провайдер) без имени → false; с чужим именем → false
    expect(isUberProvider(null, "del_FAKE_per_delivery")).toBe(false);
    expect(isUberProvider("doordash", "del_FAKE_per_delivery")).toBe(false);
  });
});

describe("pickCostCents — приоритет total_amount_due, fallback fee", () => {
  it("total_amount_due приоритетнее fee", () => {
    expect(pickCostCents(1234, 999)).toBe(1234);
  });
  it("нет total → fee", () => {
    expect(pickCostCents(null, 999)).toBe(999);
    expect(pickCostCents(undefined, 999)).toBe(999);
  });
  it("нет суммы → null (старое не обнуляем)", () => {
    expect(pickCostCents(null, null)).toBeNull();
    expect(pickCostCents(undefined, undefined)).toBeNull();
  });
  it("0 — валидная сумма", () => {
    expect(pickCostCents(0, 500)).toBe(0);
  });
});

describe("centsToDollars — cents → Decimal-число", () => {
  it("конвертирует корректно", () => {
    expect(centsToDollars(1234)).toBe(12.34);
    expect(centsToDollars(50000)).toBe(500);
    expect(centsToDollars(999)).toBe(9.99);
    expect(centsToDollars(0)).toBe(0);
  });
});

describe("decideCostUpdate", () => {
  const noPrior = { finalCostUpdatedAt: null };
  const base = { provider: "uber", providerId: "prov_u", currency: "USD", quoteId: "q1" };

  it("Uber + total_amount_due → apply, dollars из total", () => {
    const r = decideCostUpdate(noPrior, { ...base, totalAmountDueCents: 1550, feeCents: 1200, occurredAt: new Date() });
    expect(r).toMatchObject({ apply: true, cents: 1550, dollars: 15.5 });
  });

  it("Uber без total → fee", () => {
    const r = decideCostUpdate(noPrior, { ...base, totalAmountDueCents: null, feeCents: 1200, occurredAt: new Date() });
    expect(r).toMatchObject({ apply: true, cents: 1200, dollars: 12 });
  });

  it("другой провайдер → not_uber (стоимость игнорируется)", () => {
    const r = decideCostUpdate(noPrior, { ...base, provider: "doordash", totalAmountDueCents: 1550, feeCents: null, occurredAt: new Date() });
    expect(r).toEqual({ apply: false, reason: "not_uber" });
  });

  it("нет суммы → no_valid_amount (старое не обнуляется)", () => {
    const r = decideCostUpdate(noPrior, { ...base, totalAmountDueCents: null, feeCents: null, occurredAt: new Date() });
    expect(r).toEqual({ apply: false, reason: "no_valid_amount" });
  });

  it("более новое событие → apply", () => {
    const r = decideCostUpdate({ finalCostUpdatedAt: new Date("2026-07-20T10:00:00Z") }, { ...base, totalAmountDueCents: 1600, feeCents: null, occurredAt: new Date("2026-07-20T11:00:00Z") });
    expect(r).toMatchObject({ apply: true, cents: 1600 });
  });

  it("устаревшее событие → stale (не откатывает)", () => {
    const r = decideCostUpdate({ finalCostUpdatedAt: new Date("2026-07-20T11:00:00Z") }, { ...base, totalAmountDueCents: 1600, feeCents: null, occurredAt: new Date("2026-07-20T10:00:00Z") });
    expect(r).toEqual({ apply: false, reason: "stale" });
  });
});
