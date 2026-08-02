import { describe, it, expect } from "vitest";
import { resolveExpensePeriod, yearOptions } from "./expensePeriod";

const NOW = new Date("2026-08-02T12:00:00.000Z");

describe("период истории расходов", () => {
  it("по умолчанию — текущий месяц целиком", () => {
    const p = resolveExpensePeriod({}, NOW);
    expect(p.kind).toBe("month");
    expect(p.from!.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(p.to!.toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("последний день короткого месяца не съезжает", () => {
    const p = resolveExpensePeriod({ year: "2026", month: "2" }, NOW);
    expect(p.to!.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("високосный февраль считается по календарю, а не по таблице длин", () => {
    const p = resolveExpensePeriod({ year: "2028", month: "2" }, NOW);
    expect(p.to!.toISOString().slice(0, 10)).toBe("2028-02-29");
  });

  it("выбор месяца и года работает независимо от текущей даты", () => {
    const p = resolveExpensePeriod({ period: "month", year: "2025", month: "12" }, NOW);
    expect(p.from!.toISOString().slice(0, 10)).toBe("2025-12-01");
    expect(p.to!.toISOString().slice(0, 10)).toBe("2025-12-31");
  });

  it("год — это год целиком", () => {
    const p = resolveExpensePeriod({ period: "year", year: "2025" }, NOW);
    expect(p.from!.toISOString().slice(0, 10)).toBe("2025-01-01");
    expect(p.to!.toISOString().slice(0, 10)).toBe("2025-12-31");
  });

  it("вся история не ставит границ вовсе", () => {
    const p = resolveExpensePeriod({ period: "all" }, NOW);
    expect(p.from).toBeNull();
    expect(p.to).toBeNull();
  });

  it("произвольный период берётся как задан", () => {
    const p = resolveExpensePeriod({ period: "range", from: "2026-01-15", to: "2026-03-04" }, NOW);
    expect(p.from!.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(p.to!.toISOString().slice(0, 10)).toBe("2026-03-04");
  });

  it("мусор в параметрах не роняет страницу и не выдумывает границ", () => {
    const p = resolveExpensePeriod({ period: "range", from: "вчера", to: "" }, NOW);
    expect(p.from).toBeNull();
    expect(p.to).toBeNull();
  });

  it("месяц вне 1..12 не даёт несуществующую дату, а откатывается к текущему", () => {
    for (const month of ["0", "77", "-3", "abc", "6.5"]) {
      const p = resolveExpensePeriod({ month }, NOW);
      expect(p.from!.toISOString().slice(0, 10)).toBe("2026-08-01");
      expect(p.to!.toISOString().slice(0, 10)).toBe("2026-08-31");
    }
  });

  it("годы для списка идут от текущего до первого года с данными", () => {
    expect(yearOptions(new Date("2024-03-01T00:00:00.000Z"), NOW)).toEqual([2026, 2025, 2024]);
    expect(yearOptions(null, NOW)).toEqual([2026]);
  });
});
