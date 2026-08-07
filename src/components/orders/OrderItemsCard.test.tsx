import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderItemsCard, type OrderItemView } from "./OrderItemsCard";

/**
 * Незаданная цена флориста должна быть ВИДНА.
 *
 * История: раньше при ненайденной цене подставлялась цена КЛИЕНТА — число выглядело
 * настоящим, и владелец узнавал о пробеле от флориста (JF-1000970: $239 вместо $167).
 * Фолбэк заменён на ноль, но «$0.00» читается как «делаем бесплатно» и прячет проблему
 * ровно так же. Поэтому ноль-из-за-незаполненного-прайса показывается словами.
 */
const item = (prices: OrderItemView["prices"]): OrderItemView => ({
  id: "i1",
  name: "Rose Majesty",
  quantity: 1,
  image: null,
  variantImage: null,
  prices,
});

const render = (prices: OrderItemView["prices"]) =>
  renderToStaticMarkup(<OrderItemsCard items={[item(prices)]} />);

describe("цена позиции в карточке заказа", () => {
  it("незаданная цена показывается словами, а не нулём", () => {
    const html = render([{ value: 0, label: "флористу", missing: true }]);
    expect(html).toContain("не задана");
    expect(html).not.toContain("$0.00");
  });

  it("подпись остаётся на месте — понятно, ЧЬЯ цена не задана", () => {
    expect(render([{ value: 0, label: "флористу", missing: true }])).toContain("флористу");
  });

  it("настоящий ноль (делаем бесплатно) показывается суммой", () => {
    // Явный ноль — валидная цена, и подменять его словами нельзя.
    const html = render([{ value: 0, label: "флористу" }]);
    expect(html).toContain("$0.00");
    expect(html).not.toContain("не задана");
  });

  it("обычная цена не затронута", () => {
    const html = render([{ value: 167, label: "флористу" }]);
    expect(html).toContain("$167.00");
    expect(html).not.toContain("не задана");
  });

  it("две цены: не заданной может быть только одна", () => {
    const html = render([
      { value: 239, label: "клиенту" },
      { value: 0, label: "флористу", missing: true },
    ]);
    expect(html).toContain("$239.00");
    expect(html).toContain("не задана");
  });
});
