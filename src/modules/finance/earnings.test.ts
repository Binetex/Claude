import { describe, it, expect } from "vitest";
import { resolvePeriod, keyFromDay } from "./earnings";
import { pluralOrders, formatDayLong, formatMonthTitle } from "./earningsFormat";

/**
 * Границы периодов — чистая арифметика дней, без БД. «Сегодня» берётся по календарю
 * магазина (America/Los_Angeles), а не по UTC: иначе вечером у флориста «сегодня» съезжало
 * бы на завтра, а его заказы — в пустой день.
 */
describe("resolvePeriod", () => {
  // 3 августа 2026, 10:00 UTC = 03:00 в Лос-Анджелесе того же дня.
  const now = new Date("2026-08-03T10:00:00.000Z");
  // 3 августа 2026, 04:00 UTC = ещё 2 августа, 21:00 в Лос-Анджелесе.
  const lateNight = new Date("2026-08-03T04:00:00.000Z");

  it("today — один день", () => {
    const p = resolvePeriod("today", {}, now);
    expect([keyFromDay(p.from), keyFromDay(p.to), p.singleDay]).toEqual(["2026-08-03", "2026-08-03", true]);
  });

  it("«сегодня» считается по календарю магазина, а не по UTC", () => {
    const p = resolvePeriod("today", {}, lateNight);
    expect(keyFromDay(p.from)).toBe("2026-08-02");
  });

  it("yesterday — предыдущий день", () => {
    const p = resolvePeriod("yesterday", {}, now);
    expect([keyFromDay(p.from), keyFromDay(p.to), p.singleDay]).toEqual(["2026-08-02", "2026-08-02", true]);
  });

  it("week — последние 7 дней включая сегодня", () => {
    const p = resolvePeriod("week", {}, now);
    expect([keyFromDay(p.from), keyFromDay(p.to), p.singleDay]).toEqual(["2026-07-28", "2026-08-03", false]);
  });

  it("month — с первого числа ТЕКУЩЕГО месяца, а не последние 30 дней", () => {
    const p = resolvePeriod("month", {}, now);
    expect([keyFromDay(p.from), keyFromDay(p.to)]).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("по умолчанию — этот месяц", () => {
    expect(resolvePeriod(undefined, {}, now).key).toBe("month");
    expect(resolvePeriod("мусор", {}, now).key).toBe("month");
  });

  it("custom — свои даты; перевёрнутый диапазон разворачивается", () => {
    const p = resolvePeriod("custom", { from: "2026-08-05", to: "2026-08-01" }, now);
    expect([keyFromDay(p.from), keyFromDay(p.to)]).toEqual(["2026-08-01", "2026-08-05"]);
    expect(p.label).toBe("1 августа — 5 августа");
  });

  it("custom из одного дня показывается как однодневный период с одной датой в подписи", () => {
    const p = resolvePeriod("custom", { from: "2026-08-02", to: "2026-08-02" }, now);
    expect([p.singleDay, p.label]).toEqual([true, "2 августа"]);
  });

  it("custom с мусорными датами не ломает страницу — откат на месяц", () => {
    expect(resolvePeriod("custom", { from: "вчера", to: "" }, now).key).toBe("month");
  });
});

describe("подписи", () => {
  it("русские окончания у количества заказов", () => {
    expect(pluralOrders(1)).toBe("1 заказ");
    expect(pluralOrders(3)).toBe("3 заказа");
    expect(pluralOrders(5)).toBe("5 заказов");
    expect(pluralOrders(11)).toBe("11 заказов"); // не «11 заказ»
    expect(pluralOrders(21)).toBe("21 заказ");
    expect(pluralOrders(112)).toBe("112 заказов");
    expect(pluralOrders(0)).toBe("0 заказов");
  });

  it("день выводится календарной датой, без сдвига через таймзону", () => {
    expect(formatDayLong("2026-08-03")).toBe("3 августа");
  });

  it("заголовок месяца без хвоста « г.», с заглавной", () => {
    expect(formatMonthTitle(new Date("2026-08-02T00:00:00.000Z"))).toBe("Август 2026");
    expect(formatMonthTitle(new Date("2026-07-25T00:00:00.000Z"))).toBe("Июль 2026");
  });
});
