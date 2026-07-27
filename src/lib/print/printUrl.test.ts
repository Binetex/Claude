import { describe, it, expect } from "vitest";
import { printCardsUrl } from "./printUrl";

describe("адрес печати открыток", () => {
  it("ведёт на тот же документ, что и вкладка «Открытки для печати»", () => {
    // Своего шаблона у карточки заказа нет — обе точки входа открывают /print/order-cards.
    expect(printCardsUrl("abc123")).toBe("/print/order-cards?ids=abc123");
  });

  it("несколько заказов — через запятую одним документом", () => {
    expect(printCardsUrl(["a", "b"])).toBe("/print/order-cards?ids=a%2Cb");
  });

  it("посторонние значения в id экранируются", () => {
    // id приходит из данных страницы, но URL всё равно собираем безопасно.
    expect(printCardsUrl("a&b=1")).toBe("/print/order-cards?ids=a%26b%3D1");
  });

  it("пустые значения отбрасываются", () => {
    expect(printCardsUrl(["a", "", "b"])).toBe("/print/order-cards?ids=a%2Cb");
  });
});
