import { describe, it, expect } from "vitest";
import { showsStoreClock } from "./AppShell";

/**
 * 21.09.2026: часы поставили всем, и флорист получил в шапке чужой часовой пояс. Он собирает
 * букет у себя в студии и живёт по своим часам; по времени Лос-Анджелеса работают те, кто
 * ведёт заказы — владелец и колл-центр.
 */
describe("кому показываются часы магазина", () => {
  it("владельцу и колл-центру — да, флористу — нет", () => {
    expect(showsStoreClock("OWNER")).toBe(true);
    expect(showsStoreClock("CALL_CENTER")).toBe(true);
    expect(showsStoreClock("FLORIST")).toBe(false);
  });
});
