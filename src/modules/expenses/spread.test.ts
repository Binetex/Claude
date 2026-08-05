import { describe, it, expect } from "vitest";
import { allocateRule, splitCents, daysInWindow, utcDay, type ExpenseRule } from "./spread";

const rule = (over: Partial<ExpenseRule>): ExpenseRule => ({
  id: "r1",
  kind: "DAILY",
  amountCents: 100,
  startDay: utcDay("2026-08-01"),
  endDay: null,
  ...over,
});

const sum = (parts: { cents: number }[]) => parts.reduce((a, p) => a + p.cents, 0);
const AUG = { from: utcDay("2026-08-01"), to: utcDay("2026-08-31") };

describe("деление суммы на дни", () => {
  it("сумма частей всегда равна исходной — центы не теряются", () => {
    // 6300 / 31 не делится нацело: без раздачи остатка месяц не сошёлся бы с днями.
    const parts = splitCents(6300, 31);
    expect(parts).toHaveLength(31);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(6300);
  });

  it("остаток уходит первым дням, разброс не больше цента", () => {
    const parts = splitCents(100, 3);
    expect(parts).toEqual([34, 33, 33]);
  });
});

describe("разовый расход", () => {
  it("вся сумма попадает в один день", () => {
    const parts = allocateRule(rule({ kind: "ONE_OFF", amountCents: 1200, startDay: utcDay("2026-08-02") }), AUG.from, AUG.to);
    expect(parts).toEqual([{ ruleId: "r1", day: "2026-08-02", cents: 1200 }]);
  });

  it("живёт ровно один день, даже если срок кем-то заполнен", () => {
    const parts = allocateRule(
      rule({ kind: "ONE_OFF", amountCents: 500, startDay: utcDay("2026-08-02"), endDay: utcDay("2026-08-20") }),
      AUG.from, AUG.to
    );
    expect(parts).toHaveLength(1);
  });
});

describe("ежедневный расход", () => {
  it("сумма повторяется каждый день срока", () => {
    const parts = allocateRule(rule({ kind: "DAILY", amountCents: 210 }), AUG.from, AUG.to);
    expect(parts).toHaveLength(31);
    expect(parts.every((p) => p.cents === 210)).toBe(true);
  });

  it("бессрочный расход не начинается раньше своей даты", () => {
    const parts = allocateRule(rule({ kind: "DAILY", amountCents: 210, startDay: utcDay("2026-08-10") }), AUG.from, AUG.to);
    expect(parts[0].day).toBe("2026-08-10");
    expect(parts).toHaveLength(22);
  });

  it("закончившийся расход в следующем месяце не появляется", () => {
    const parts = allocateRule(
      rule({ kind: "DAILY", amountCents: 210, endDay: utcDay("2026-08-31") }),
      utcDay("2026-09-01"), utcDay("2026-09-30")
    );
    expect(parts).toHaveLength(0);
  });
});

describe("ежемесячный расход", () => {
  it("месячная сумма делится на дни месяца и сходится в точности", () => {
    const parts = allocateRule(rule({ kind: "MONTHLY", amountCents: 6300 }), AUG.from, AUG.to);
    expect(parts).toHaveLength(31);
    expect(sum(parts)).toBe(6300); // ровно месячная сумма, ни центом больше
    expect(parts[0].cents).toBe(204); // 6300/31 = 203.2 → первым дням по центу больше
    expect(parts[30].cents).toBe(203);
  });

  it("в каждом месяце своя длина — февраль не наследует январь", () => {
    const monthly = { kind: "MONTHLY" as const, amountCents: 3100, startDay: utcDay("2026-01-01") };
    const jan = allocateRule(rule(monthly), utcDay("2026-01-01"), utcDay("2026-01-31"));
    const feb = allocateRule(rule(monthly), utcDay("2026-02-01"), utcDay("2026-02-28"));
    expect(sum(jan)).toBe(3100);
    expect(sum(feb)).toBe(3100);
    expect(jan).toHaveLength(31);
    expect(feb).toHaveLength(28);
  });

  it("начавшись в середине месяца, отдаёт за него ПОЛНУЮ месячную сумму", () => {
    // Платёж за месяц один, и он состоялся — просто срок начался 15-го. Размазать
    // половину означало бы показать расход, которого не было.
    const parts = allocateRule(
      rule({ kind: "MONTHLY", amountCents: 6300, startDay: utcDay("2026-08-15") }),
      AUG.from, AUG.to
    );
    expect(parts).toHaveLength(17);
    expect(sum(parts)).toBe(6300);
  });

  it("окно просмотра не влияет на размер дневной доли", () => {
    // Открытие одной недели не должно менять то, сколько расход стоит в день.
    const full = allocateRule(rule({ kind: "MONTHLY", amountCents: 6300 }), AUG.from, AUG.to);
    const week = allocateRule(rule({ kind: "MONTHLY", amountCents: 6300 }), utcDay("2026-08-05"), utcDay("2026-08-11"));
    expect(week).toHaveLength(7);
    expect(week.map((p) => p.cents)).toEqual(full.slice(4, 11).map((p) => p.cents));
  });
});

describe("расход за произвольный срок", () => {
  it("сумма делится на весь срок и сходится", () => {
    const parts = allocateRule(
      rule({ kind: "RANGE", amountCents: 1000, startDay: utcDay("2026-08-01"), endDay: utcDay("2026-08-10") }),
      AUG.from, AUG.to
    );
    expect(parts).toHaveLength(10);
    expect(sum(parts)).toBe(1000);
    expect(parts.every((p) => p.cents === 100)).toBe(true);
  });

  it("знаменатель — весь срок, а не видимая часть", () => {
    // Срок 10 дней по $1; смотрим только три из них — доля обязана остаться $1,
    // иначе расход «дорожал» бы от того, что мы сузили окно.
    const parts = allocateRule(
      rule({ kind: "RANGE", amountCents: 1000, startDay: utcDay("2026-08-01"), endDay: utcDay("2026-08-10") }),
      utcDay("2026-08-03"), utcDay("2026-08-05")
    );
    expect(parts.map((p) => p.cents)).toEqual([100, 100, 100]);
  });

  it("срок, пересекающий месяцы, делится ровно по всей длине", () => {
    const parts = allocateRule(
      rule({ kind: "RANGE", amountCents: 6100, startDay: utcDay("2026-08-20"), endDay: utcDay("2026-09-10") }),
      utcDay("2026-08-01"), utcDay("2026-09-30")
    );
    expect(parts).toHaveLength(22);
    expect(sum(parts)).toBe(6100);
  });
});

describe("окно дней", () => {
  it("включает обе границы и пустые дни", () => {
    expect(daysInWindow(utcDay("2026-08-01"), utcDay("2026-08-03"))).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });
});
