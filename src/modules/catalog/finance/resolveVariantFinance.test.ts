import { describe, it, expect } from "vitest";
import { resolveVariantFinance, type VaseCostRow } from "./resolveVariantFinance";

const AT = new Date("2026-10-15T00:00:00Z");

const variant = (over: Partial<{ financialType: never; includesVase: boolean | null }> = {}) => ({
  id: "v1",
  financialType: null,
  includesVase: null,
  ...over,
}) as Parameters<typeof resolveVariantFinance>[0]["variant"];

const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  financialType: null,
  defaultIncludesVase: null,
  ...over,
}) as Parameters<typeof resolveVariantFinance>[0]["product"];

const cost = (over: Partial<VaseCostRow>): VaseCostRow => ({
  id: "c1",
  productId: null,
  productVariantId: "v1",
  costType: "INCLUDED_VASE",
  purchaseCostCents: 1200,
  effectiveFrom: new Date("2026-08-01T00:00:00Z"),
  effectiveTo: null,
  ...over,
});

describe("самостоятельная ваза", () => {
  it("берёт STANDALONE_VASE и игнорирует includesVase", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "VASE" as never, includesVase: true }),
      product: product(),
      costs: [
        cost({ id: "s1", costType: "STANDALONE_VASE", purchaseCostCents: 1200 }),
        cost({ id: "i1", costType: "INCLUDED_VASE", purchaseCostCents: 9900 }),
      ],
      at: AT,
    });
    expect(r.financialType).toBe("VASE");
    expect(r.vaseCostCents).toBe(1200);
    expect(r.vaseCostType).toBe("STANDALONE_VASE");
    expect(r.vaseCostRecordId).toBe("s1");
    expect(r.reviewReasons).toEqual([]);
  });

  it("без записи стоимости → VASE_COST_MISSING", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "VASE" as never }),
      product: product(),
      costs: [],
      at: AT,
    });
    expect(r.vaseCostCents).toBeNull();
    expect(r.reviewReasons).toContain("VASE_COST_MISSING");
  });
});

describe("букет с вазой", () => {
  it("наследует тип и признак от товара и берёт товарную стоимость", () => {
    const r = resolveVariantFinance({
      variant: variant(),
      product: product({ financialType: "FLOWER_PRODUCT", defaultIncludesVase: true }),
      costs: [cost({ id: "pc", productId: "p1", productVariantId: null, purchaseCostCents: 1200 })],
      at: AT,
    });
    expect(r.financialType).toBe("FLOWER_PRODUCT");
    expect(r.financialTypeSource).toBe("PRODUCT");
    expect(r.includesVase).toBe(true);
    expect(r.includesVaseSource).toBe("PRODUCT");
    expect(r.vaseCostCents).toBe(1200);
    expect(r.vaseCostSource).toBe("PRODUCT");
  });

  it("стоимость варианта приоритетнее товарной", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true }),
      product: product({ financialType: "FLOWER_PRODUCT", defaultIncludesVase: true }),
      costs: [
        cost({ id: "pc", productId: "p1", productVariantId: null, purchaseCostCents: 1200 }),
        cost({ id: "vc", purchaseCostCents: 2600 }),
      ],
      at: AT,
    });
    expect(r.vaseCostCents).toBe(2600);
    expect(r.vaseCostSource).toBe("VARIANT");
    expect(r.vaseCostRecordId).toBe("vc");
  });

  it("STANDALONE_VASE к букету не применяется", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "FLOWER_PRODUCT" as never, includesVase: true }),
      product: product(),
      costs: [cost({ id: "s1", costType: "STANDALONE_VASE", purchaseCostCents: 5000 })],
      at: AT,
    });
    expect(r.vaseCostCents).toBeNull();
    expect(r.reviewReasons).toContain("VASE_COST_MISSING");
  });
});

describe("букет без вазы", () => {
  it("includesVase=false не применяет стоимость и не поднимает VASE_COST_MISSING", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "FLOWER_PRODUCT" as never, includesVase: false }),
      product: product({ defaultIncludesVase: true }),
      costs: [cost({ id: "vc", purchaseCostCents: 1200 })], // историческая запись сохранена
      at: AT,
    });
    expect(r.includesVase).toBe(false);
    expect(r.includesVaseSource).toBe("VARIANT");
    expect(r.vaseCostCents).toBeNull();
    expect(r.reviewReasons).toEqual([]);
  });

  it("неизвестный признак вазы — это не «вазы нет»", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "FLOWER_PRODUCT" as never }),
      product: product(),
      costs: [],
      at: AT,
    });
    expect(r.includesVase).toBeNull();
    expect(r.includesVaseSource).toBe("UNKNOWN");
    expect(r.reviewReasons).toContain("VASE_COST_MISSING");
  });
});

describe("классификация", () => {
  it("тип не задан нигде → ITEM_UNCLASSIFIED", () => {
    const r = resolveVariantFinance({ variant: variant(), product: product(), costs: [], at: AT });
    expect(r.financialType).toBeNull();
    expect(r.financialTypeSource).toBe("UNKNOWN");
    expect(r.reviewReasons).toContain("ITEM_UNCLASSIFIED");
  });

  it("вариант переопределяет тип товара", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "GIFT" as never }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [],
      at: AT,
    });
    expect(r.financialType).toBe("GIFT");
    expect(r.financialTypeSource).toBe("VARIANT");
  });
});

describe("даты действия", () => {
  const rows = [
    cost({ id: "old", purchaseCostCents: 1000, effectiveFrom: new Date("2026-07-01"), effectiveTo: new Date("2026-08-01") }),
    cost({ id: "mid", purchaseCostCents: 1200, effectiveFrom: new Date("2026-08-01"), effectiveTo: new Date("2026-11-01") }),
    cost({ id: "new", purchaseCostCents: 1500, effectiveFrom: new Date("2026-11-01"), effectiveTo: null }),
  ];
  const resolveAt = (at: Date) =>
    resolveVariantFinance({
      variant: variant({ financialType: "FLOWER_PRODUCT" as never, includesVase: true }),
      product: product(),
      costs: rows,
      at,
    });

  it("подорожание не меняет расчёт заказа с прошлой датой доставки", () => {
    expect(resolveAt(new Date("2026-07-15")).vaseCostCents).toBe(1000);
    expect(resolveAt(new Date("2026-10-15")).vaseCostCents).toBe(1200);
    expect(resolveAt(new Date("2026-11-20")).vaseCostCents).toBe(1500);
  });

  it("до первого интервала стоимость неизвестна", () => {
    const r = resolveAt(new Date("2026-06-15"));
    expect(r.vaseCostCents).toBeNull();
    expect(r.reviewReasons).toContain("VASE_COST_MISSING");
  });

  it("граница периода полуоткрытая: день начала берёт новый интервал", () => {
    expect(resolveAt(new Date("2026-08-01")).vaseCostCents).toBe(1200);
    expect(resolveAt(new Date("2026-11-01")).vaseCostCents).toBe(1500);
  });
});

describe("цена клиента", () => {
  it("не участвует в резолве: listPrice в функцию не передаётся вовсе", () => {
    // Контрактная проверка формы входа: себестоимость может прийти только из costs.
    const r = resolveVariantFinance({
      variant: variant({ financialType: "VASE" as never }),
      product: product(),
      costs: [],
      at: AT,
    });
    expect(r.vaseCostCents).toBeNull();
  });
});
