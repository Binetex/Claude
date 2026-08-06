import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderContactCards } from "./OrderContactCards";

/**
 * Показ телефонов в карточках. Правило: разные номера видны оба, одинаковый — один раз.
 *
 * Проверяется разметкой, потому что цена ошибки уже известна: в PAR-41318 телефон
 * заказчицы не показывался вовсе, и с ней не смогли связаться.
 */
const render = (recipientPhone: string, customerPhone: string) =>
  renderToStaticMarkup(
    <OrderContactCards
      recipient={{ name: "Aspen Yessayan", phone: recipientPhone }}
      customer={{ name: "Jamella Aninon", phone: customerPhone }}
    />
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("телефоны в карточках заказа", () => {
  it("разные номера — показаны оба", () => {
    const html = render("+18646427700", "+13472607553");
    expect(html).toContain("+18646427700");
    expect(html).toContain("+13472607553");
    expect(html).not.toContain("тот же");
  });

  it("оба имени на месте", () => {
    const html = render("+18646427700", "+13472607553");
    expect(html).toContain("Aspen Yessayan");
    expect(html).toContain("Jamella Aninon");
  });

  it("один и тот же номер в разном формате — не дублируется", () => {
    const html = render("+1 347-260-7553", "(347) 260-7553");
    expect(count(html, "347")).toBe(1); // номер выведен ровно один раз
    expect(html).toContain("тот же, что у получателя");
  });

  it("совпавший номер остаётся у ПОЛУЧАТЕЛЯ — по нему едут", () => {
    const html = render("+13472607553", "+13472607553");
    const phoneAt = html.indexOf("+13472607553");
    const hintAt = html.indexOf("тот же, что у получателя");
    expect(phoneAt).toBeGreaterThan(-1);
    // Карточка получателя идёт первой, значит номер стоит раньше пояснения.
    expect(phoneAt).toBeLessThan(hintAt);
  });

  it("пустые номера не схлопываются в «тот же»", () => {
    // Иначе два «телефона нет» выглядели бы как один общий контакт.
    const html = render("", "");
    expect(html).not.toContain("тот же");
    expect(count(html, "—")).toBeGreaterThanOrEqual(2);
  });

  it("номер только у одного — второй не превращается в «тот же»", () => {
    const html = render("+18646427700", "");
    expect(html).toContain("+18646427700");
    expect(html).not.toContain("тот же");
  });
});
