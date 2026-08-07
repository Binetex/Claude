import { describe, it, expect } from "vitest";
import { resolvePeriod } from "./period";

/**
 * 15 августа 2026, 03:00 UTC. В Лос-Анджелесе это ещё 14 августа, 20:00 — на этой границе и
 * ломались бы периоды, если бы «сегодня» брали из UTC.
 */
const NOW = new Date("2026-08-15T03:00:00.000Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("период страницы «Магазины»", () => {
  it("по умолчанию — текущий месяц", () => {
    const p = resolvePeriod({}, NOW);
    expect(p.kind).toBe("month");
    expect(iso(p.from)).toBe("2026-08-01");
    expect(iso(p.to)).toBe("2026-08-31");
    expect(p.label).toBe("август 2026");
  });

  it("«сегодня» — по таймзоне магазина, а не по UTC", () => {
    // В UTC уже 15-е, в Лос-Анджелесе ещё 14-е. Заказы живут по местному дню.
    const p = resolvePeriod({ period: "today" }, NOW);
    expect(iso(p.from)).toBe("2026-08-14");
    expect(iso(p.to)).toBe("2026-08-14");
    expect(p.label).toBe("14 августа 2026");
  });

  it("«вчера» — один день, предыдущий", () => {
    const p = resolvePeriod({ period: "yesterday" }, NOW);
    expect(iso(p.from)).toBe("2026-08-13");
    expect(iso(p.to)).toBe("2026-08-13");
  });

  it("«неделя» — последние 7 дней, включая сегодня", () => {
    const p = resolvePeriod({ period: "week" }, NOW);
    expect(iso(p.from)).toBe("2026-08-08");
    expect(iso(p.to)).toBe("2026-08-14");
  });

  it("месяц заканчивается последним числом, а не 30-м всегда", () => {
    expect(iso(resolvePeriod({}, new Date("2026-02-10T12:00:00.000Z")).to)).toBe("2026-02-28");
    expect(iso(resolvePeriod({}, new Date("2028-02-10T12:00:00.000Z")).to)).toBe("2028-02-29");
    expect(iso(resolvePeriod({}, new Date("2026-04-10T12:00:00.000Z")).to)).toBe("2026-04-30");
  });

  it("свой диапазон берётся как есть", () => {
    const p = resolvePeriod({ period: "range", from: "2026-07-01", to: "2026-07-10" }, NOW);
    expect(p.kind).toBe("range");
    expect(iso(p.from)).toBe("2026-07-01");
    expect(iso(p.to)).toBe("2026-07-10");
    expect(p.label).toBe("1 июля 2026 — 10 июля 2026");
  });

  it("перевёрнутый диапазон разворачивается, а не даёт пустоту", () => {
    const p = resolvePeriod({ period: "range", from: "2026-07-10", to: "2026-07-01" }, NOW);
    expect(iso(p.from)).toBe("2026-07-01");
    expect(iso(p.to)).toBe("2026-07-10");
  });

  it("одна дата с обеих сторон подписывается как день, а не как диапазон", () => {
    const p = resolvePeriod({ period: "range", from: "2026-07-04", to: "2026-07-04" }, NOW);
    expect(p.label).toBe("4 июля 2026");
  });

  it("половина диапазона достраивается сегодняшним днём", () => {
    const p = resolvePeriod({ period: "range", from: "2026-08-01" }, NOW);
    expect(iso(p.from)).toBe("2026-08-01");
    expect(iso(p.to)).toBe("2026-08-14");
  });

  it("мусор в параметрах не роняет страницу — остаётся месяц по умолчанию", () => {
    expect(resolvePeriod({ period: "квартал" }, NOW).kind).toBe("month");
    const broken = resolvePeriod({ period: "range", from: "2026-13-45", to: "нет" }, NOW);
    expect(iso(broken.from)).toBe("2026-08-14");
    expect(iso(broken.to)).toBe("2026-08-14");
  });

  it("границы — UTC-полночь, как у deliveryDate", () => {
    const p = resolvePeriod({ period: "today" }, NOW);
    expect(p.from.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });
});
