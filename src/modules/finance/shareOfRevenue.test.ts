import { describe, it, expect } from "vitest";
import { shareOfRevenue } from "./earningsFormat";

/**
 * Доля величины в выручке — то, ради чего владелец и смотрит на эти цифры: не «сколько
 * долларов», а «сколько съедают расходы, флористы и сколько остаётся мне».
 *
 * Главное здесь — не показать процент там, где он был бы ложью.
 */
describe("доля в выручке", () => {
  it("обычный случай", () => {
    expect(shareOfRevenue(355195, 831835)).toBe("43%");
    expect(shareOfRevenue(312794, 831835)).toBe("38%");
  });

  it("убыток показывается со знаком, а не прячется", () => {
    expect(shareOfRevenue(-45871, 147530)).toBe("-31%");
  });

  it("нет выручки — процента нет: делить не на что", () => {
    // «0%» здесь было бы враньём: расход есть, а доли у него нет.
    expect(shareOfRevenue(5000, 0)).toBeNull();
    expect(shareOfRevenue(5000, -100)).toBeNull();
  });

  it("величина неизвестна — процента нет", () => {
    // День не посчитан: на месте суммы стоит прочерк, доле взяться неоткуда.
    expect(shareOfRevenue(null, 831835)).toBeNull();
    expect(shareOfRevenue(undefined, 831835)).toBeNull();
  });

  it("ноль — это настоящий ноль процентов, а не «неизвестно»", () => {
    expect(shareOfRevenue(0, 831835)).toBe("0%");
  });

  it("сумма долей трёх величин даёт сотню", () => {
    // Выручка = расходы + флористы + прибыль, значит и проценты складываются в 100.
    const revenue = 831835;
    const parts = [355195, 312794, revenue - 355195 - 312794];
    const sum = parts.reduce((a, p) => a + Number(shareOfRevenue(p, revenue)!.replace("%", "")), 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(1); // расхождение только от округления
  });
});
