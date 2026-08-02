/**
 * Сумма начисления: что входит, что нет, и когда начисление не создаётся вовсе.
 *
 * Главное правило, которое здесь закреплено: чаевые никогда не попадают в деньги флориста,
 * а ручную сумму владельца мы не пересчитываем.
 */
import { describe, it, expect } from "vitest";
import { assessAccrual } from "./accrualRules";

const item = (name: string, floristItemPrice: number, catalog = true) => ({
  name,
  productId: catalog ? "p1" : null,
  variantId: catalog ? "v1" : null,
  floristItemPrice,
});

describe("авто-цена", () => {
  it("обычный заказ: сумма снимка идёт в начисление как есть", () => {
    const r = assessAccrual({ priceMode: "AUTO", floristTotal: 118, items: [item("Bouquet", 118)] });
    expect(r.status).toBe("OK");
    expect(r.amountCents).toBe(11800);
    expect(r.provenance).toBe("AUTO_SNAPSHOT");
  });

  it("чаевые внутри снимка вычитаются: 152.10 − 33.80 = 118.30", () => {
    const r = assessAccrual({
      priceMode: "AUTO",
      floristTotal: 152.1,
      items: [item("Bouquet", 118.3), item("Tip", 33.8, false)],
    });
    expect(r.status).toBe("OK");
    expect(r.amountCents).toBe(11830);
  });

  it("товар со словом Tip в названии остаётся товаром — он связан с каталогом", () => {
    const r = assessAccrual({
      priceMode: "AUTO",
      floristTotal: 90,
      items: [item("Tulip Tips Bouquet", 90)],
    });
    expect(r.amountCents).toBe(9000);
  });

  it("нулевой снимок означает «цена не задана» — начисление не создаётся", () => {
    const r = assessAccrual({ priceMode: "AUTO", floristTotal: 0, items: [item("Bouquet", 0)] });
    expect(r.status).toBe("FLORIST_PRICE_MISSING");
    expect(r.amountCents).toBe(0);
  });

  it("заказ, где весь снимок — чаевые, начислению не подлежит", () => {
    const r = assessAccrual({
      priceMode: "AUTO",
      floristTotal: 20,
      items: [item("Tip", 20, false)],
    });
    expect(r.status).toBe("FLORIST_PRICE_MISSING");
  });
});

describe("ручная цена", () => {
  it("берётся как есть и не пересчитывается", () => {
    const r = assessAccrual({ priceMode: "MANUAL", floristTotal: 135, items: [item("Bouquet", 100)] });
    expect(r.status).toBe("OK");
    expect(r.amountCents).toBe(13500);
    expect(r.provenance).toBe("MANUAL");
  });

  it("чаевые в снимке позиций не уменьшают введённую владельцем сумму", () => {
    // Реальный случай FLWBR-91157: ручные 135.00 при 17.00 чаевых в старом снимке.
    // Владелец вводил сумму уже без чаевых — вычитать их второй раз нельзя.
    const r = assessAccrual({
      priceMode: "MANUAL",
      floristTotal: 135,
      items: [item("Bouquet", 118), item("Tip", 17, false)],
    });
    expect(r.amountCents).toBe(13500);
  });

  it("ручной ноль — это тоже «не задано»", () => {
    const r = assessAccrual({ priceMode: "MANUAL", floristTotal: 0, items: [] });
    expect(r.status).toBe("FLORIST_PRICE_MISSING");
  });
});

describe("округление", () => {
  it("центы не теряются на дробных суммах", () => {
    const r = assessAccrual({ priceMode: "AUTO", floristTotal: 111.3, items: [item("Bouquet", 111.3)] });
    expect(r.amountCents).toBe(11130);
  });
});
