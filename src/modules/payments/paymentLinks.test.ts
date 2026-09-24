import { describe, it, expect } from "vitest";
import { parseAmount } from "./paymentLinks";

/**
 * Сумма уходит в Airwallex как есть — он её не пересчитывает и налог не добавляет (проверено
 * на живом API 24.09.2026: в запросе создания налоговых полей нет вовсе). Значит разбор поля
 * и есть последняя защита от того, чтобы клиенту выставили не ту цифру.
 */
describe("сумма ссылки на оплату", () => {
  it("обычные значения", () => {
    expect(parseAmount("113.40")).toBe(113.4);
    expect(parseAmount("129")).toBe(129);
    expect(parseAmount("561.60")).toBe(561.6);
  });

  it("запятая вместо точки — её набирают чаще", () => {
    expect(parseAmount("113,40")).toBe(113.4);
  });

  it("пробелы по краям и внутри не мешают", () => {
    expect(parseAmount("  1 250.50 ")).toBe(1250.5);
  });

  it("лишние знаки округляются до центов: больше Airwallex не примет", () => {
    expect(parseAmount("10.005")).toBe(10.01);
    expect(parseAmount("33.333")).toBe(33.33);
  });

  it("ноль и минус отвергаются: Airwallex требует положительную сумму", () => {
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("-0.01")).toBeNull();
  });

  it("не-число отвергается, а не превращается в ноль", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("сто")).toBeNull();
    expect(parseAmount("12$")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
  });
});
