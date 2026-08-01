import { describe, it, expect } from "vitest";
import { resolveVariantFinance, type VaseCostRow, type LinkedVaseInfo } from "./resolveVariantFinance";

const AT = new Date("2026-10-15T00:00:00Z");

type Input = Parameters<typeof resolveVariantFinance>[0];

const variant = (over: Partial<Input["variant"]> = {}): Input["variant"] => ({
  id: "v1",
  financialType: null,
  includesVase: null,
  includedVaseVariantId: null,
  ...over,
});

const product = (over: Partial<Input["product"]> = {}): Input["product"] => ({
  id: "p1",
  financialType: null,
  defaultIncludesVase: null,
  defaultIncludedVaseVariantId: null,
  ...over,
});

/** Ваза «Clear Glass Vase 8 in» — отдельный товар каталога. */
const VASE: LinkedVaseInfo = {
  id: "vase1",
  productId: "vaseProduct1",
  effectiveType: "VASE",
  archived: false,
  label: "Clear Glass Vase 8 in",
};

const cost = (over: Partial<VaseCostRow> = {}): VaseCostRow => ({
  id: "c1",
  productId: null,
  productVariantId: "vase1",
  costType: "STANDALONE_VASE",
  purchaseCostCents: 1200,
  effectiveFrom: new Date("2026-08-01T00:00:00Z"),
  effectiveTo: null,
  ...over,
});

describe("букет наследует вазу от товара", () => {
  it("тип, признак и ваза приходят от Product; стоимость — у самой вазы", () => {
    const r = resolveVariantFinance({
      variant: variant(),
      product: product({ financialType: "FLOWER_PRODUCT", defaultIncludesVase: true, defaultIncludedVaseVariantId: "vase1" }),
      costs: [cost()],
      vases: { vase1: VASE },
      at: AT,
    });
    expect(r.financialType).toBe("FLOWER_PRODUCT");
    expect(r.financialTypeSource).toBe("PRODUCT");
    expect(r.includesVase).toBe(true);
    expect(r.vase?.label).toBe("Clear Glass Vase 8 in");
    expect(r.vaseSource).toBe("PRODUCT");
    expect(r.purchaseCostCents).toBe(1200);
    expect(r.reviewReasons).toEqual([]);
  });
});

describe("вариант переопределяет вазу", () => {
  it("ссылка варианта приоритетнее товарного дефолта", () => {
    const other: LinkedVaseInfo = { ...VASE, id: "vase2", productId: "vaseProduct2", label: "Sage Sculptural Vase" };
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase2" }),
      product: product({ financialType: "FLOWER_PRODUCT", defaultIncludesVase: true, defaultIncludedVaseVariantId: "vase1" }),
      costs: [cost(), cost({ id: "c2", productVariantId: "vase2", purchaseCostCents: 2600 })],
      vases: { vase1: VASE, vase2: other },
      at: AT,
    });
    expect(r.vase?.id).toBe("vase2");
    expect(r.vaseSource).toBe("VARIANT");
    expect(r.purchaseCostCents).toBe(2600);
  });

  it("стоимость берётся с товара вазы, если у её варианта своей нет", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [cost({ id: "cp", productVariantId: null, productId: "vaseProduct1", purchaseCostCents: 900 })],
      vases: { vase1: VASE },
      at: AT,
    });
    expect(r.purchaseCostCents).toBe(900);
  });
});

describe("вариант «без вазы» отключает дефолт товара", () => {
  it("ссылка не применяется, needs review не поднимается", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: false, includedVaseVariantId: "vase1" }), // историческая ссылка
      product: product({ financialType: "FLOWER_PRODUCT", defaultIncludesVase: true, defaultIncludedVaseVariantId: "vase1" }),
      costs: [cost()],
      vases: { vase1: VASE },
      at: AT,
    });
    expect(r.includesVase).toBe(false);
    expect(r.includesVaseSource).toBe("VARIANT");
    expect(r.vase).toBeNull();
    expect(r.purchaseCostCents).toBeNull();
    expect(r.reviewReasons).toEqual([]);
  });
});

describe("needs review", () => {
  it("ваза нужна, но ссылки нет → VASE_LINK_MISSING", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [],
      at: AT,
    });
    expect(r.reviewReasons).toContain("VASE_LINK_MISSING");
    expect(r.purchaseCostCents).toBeNull();
  });

  it("ничего не настроено — обычный букет без вазы, проверять нечего", () => {
    const r = resolveVariantFinance({ variant: variant(), product: product(), costs: [], at: AT });
    expect(r.financialType).toBe("FLOWER_PRODUCT");
    expect(r.financialTypeSource).toBe("DEFAULT");
    expect(r.includesVase).toBe(false);
    expect(r.includesVaseSource).toBe("DEFAULT");
    expect(r.reviewReasons).toEqual([]);
  });

  it("ссылка есть, но у вазы нет стоимости на дату → VASE_COST_MISSING", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [],
      vases: { vase1: VASE },
      at: AT,
    });
    expect(r.vase?.id).toBe("vase1");
    expect(r.reviewReasons).toContain("VASE_COST_MISSING");
  });

  it("связанная позиция не является вазой → ссылка не применяется", () => {
    const notVase: LinkedVaseInfo = { ...VASE, effectiveType: "GIFT" };
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [cost()],
      vases: { vase1: notVase },
      at: AT,
    });
    expect(r.vase).toBeNull();
    expect(r.purchaseCostCents).toBeNull();
    expect(r.reviewReasons).toContain("VASE_LINK_MISSING");
  });

  it("архивная ваза считается, но помечается", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [cost()],
      vases: { vase1: { ...VASE, archived: true } },
      at: AT,
    });
    expect(r.purchaseCostCents).toBe(1200);
    expect(r.reviewReasons).toContain("VASE_ARCHIVED");
  });
});

describe("сама ваза", () => {
  it("позиция типа VASE берёт собственную стоимость, признак вазы не участвует", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "VASE", includesVase: true }),
      product: product(),
      costs: [cost({ id: "own", productVariantId: "v1", purchaseCostCents: 4500 })],
      at: AT,
    });
    expect(r.purchaseCostCents).toBe(4500);
    expect(r.reviewReasons).toEqual([]);
  });

  it("без записи стоимости → PURCHASE_COST_MISSING", () => {
    const r = resolveVariantFinance({ variant: variant({ financialType: "VASE" }), product: product(), costs: [], at: AT });
    expect(r.purchaseCostCents).toBeNull();
    expect(r.reviewReasons).toContain("PURCHASE_COST_MISSING");
  });

  it("у подарка и «другого» тоже есть своя закупка", () => {
    for (const type of ["GIFT", "OTHER"] as const) {
      const withCost = resolveVariantFinance({
        variant: variant({ financialType: type }),
        product: product(),
        costs: [cost({ id: "own", productVariantId: "v1", purchaseCostCents: 350 })],
        at: AT,
      });
      expect(withCost.purchaseCostCents).toBe(350);
      expect(withCost.reviewReasons).toEqual([]);

      const without = resolveVariantFinance({ variant: variant({ financialType: type }), product: product(), costs: [], at: AT });
      expect(without.purchaseCostCents).toBeNull();
      expect(without.reviewReasons).toContain("PURCHASE_COST_MISSING");
    }
  });

  it("обычный букет своей закупки не имеет — её роль играет цена флориста", () => {
    const r = resolveVariantFinance({
      variant: variant(),
      product: product(),
      costs: [cost({ id: "own", productVariantId: "v1", purchaseCostCents: 999 })],
      at: AT,
    });
    expect(r.purchaseCostCents).toBeNull();
    expect(r.reviewReasons).toEqual([]);
  });
});

describe("цена на дату доставки", () => {
  const rows = [
    cost({ id: "old", purchaseCostCents: 1000, effectiveFrom: new Date("2026-07-01"), effectiveTo: new Date("2026-08-01") }),
    cost({ id: "mid", purchaseCostCents: 1200, effectiveFrom: new Date("2026-08-01"), effectiveTo: new Date("2026-11-01") }),
    cost({ id: "new", purchaseCostCents: 1500, effectiveFrom: new Date("2026-11-01"), effectiveTo: null }),
  ];
  const at = (d: string) =>
    resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: rows,
      vases: { vase1: VASE },
      at: new Date(d),
    });

  it("подорожание вазы не меняет расчёт заказа с прошлой датой доставки", () => {
    expect(at("2026-07-15").purchaseCostCents).toBe(1000);
    expect(at("2026-10-15").purchaseCostCents).toBe(1200);
    expect(at("2026-11-20").purchaseCostCents).toBe(1500);
  });

  it("до первого интервала стоимость неизвестна", () => {
    expect(at("2026-06-15").purchaseCostCents).toBeNull();
    expect(at("2026-06-15").reviewReasons).toContain("VASE_COST_MISSING");
  });

  it("граница полуоткрытая: день начала берёт новый интервал", () => {
    expect(at("2026-08-01").purchaseCostCents).toBe(1200);
    expect(at("2026-11-01").purchaseCostCents).toBe(1500);
  });
});

describe("цена клиента", () => {
  it("listPrice в резолвер не передаётся: без записи стоимости результат null, а не цена вазы", () => {
    const r = resolveVariantFinance({
      variant: variant({ includesVase: true, includedVaseVariantId: "vase1" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [],
      vases: { vase1: VASE },
      at: AT,
    });
    expect(r.purchaseCostCents).toBeNull();
  });
});

describe("классификация", () => {
  it("умолчание действует, пока владелец не выбрал тип", () => {
    const r = resolveVariantFinance({ variant: variant(), product: product(), costs: [], at: AT });
    expect(r.financialType).toBe("FLOWER_PRODUCT");
    expect(r.financialTypeSource).toBe("DEFAULT");
  });

  it("тип товара перекрывает умолчание, вариант — тип товара", () => {
    const fromProduct = resolveVariantFinance({
      variant: variant(),
      product: product({ financialType: "VASE" }),
      costs: [],
      at: AT,
    });
    expect(fromProduct.financialType).toBe("VASE");
    expect(fromProduct.financialTypeSource).toBe("PRODUCT");
  });

  it("вариант переопределяет тип товара", () => {
    const r = resolveVariantFinance({
      variant: variant({ financialType: "GIFT" }),
      product: product({ financialType: "FLOWER_PRODUCT" }),
      costs: [],
      at: AT,
    });
    expect(r.financialType).toBe("GIFT");
    expect(r.financialTypeSource).toBe("VARIANT");
  });
});
