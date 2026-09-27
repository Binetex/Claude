import { describe, it, expect } from "vitest";
import { computeModel, driveMin, prepMin, setupMin, DEFAULT_MODEL, percentile, type DeliverySample, type PrepSample } from "./model";

const base = { since: "2026-07-29", computedAt: "2026-09-28T12:00:00Z" };

describe("модель времени: стартовые значения замера 28.09.2026", () => {
  it("без данных — стартовые значения, модель помечена как не измеренная", () => {
    const m = computeModel({ deliveries: [], prep: [], firstDispatch: [], workStart: {}, ...base });
    expect(m.courierMin).toBe(24);
    expect(m.drive.map((b) => b.min)).toEqual([28, 51, 63, 71, 90, 110]);
    expect(m.prepDefault).toEqual({ small: 45, big: 64 });
    expect(m.sample.measured).toBe(false);
  });

  it("мало доставок — не верим статистике", () => {
    const few: DeliverySample[] = Array.from({ length: 5 }, () => ({ miles: 2, waitMin: 99, driveMin: 99 }));
    const m = computeModel({ deliveries: few, prep: [], firstDispatch: [], workStart: {}, ...base });
    expect(m.courierMin).toBe(24);
    expect(m.drive[0].min).toBe(28);
  });
});

describe("модель времени: пересчёт по данным", () => {
  it("курьер и дорога — 80-й перцентиль, корзины выровнены по возрастанию", () => {
    const ds: DeliverySample[] = [];
    for (let i = 0; i < 30; i++) ds.push({ miles: 1 + (i % 2), waitMin: 10 + i, driveMin: 15 + i }); // 0–3 мили
    for (let i = 0; i < 10; i++) ds.push({ miles: 4, waitMin: 20, driveMin: 30 }); // 3–6 мили: меньше, чем 0–3
    const m = computeModel({ deliveries: ds, prep: [], firstDispatch: [], workStart: {}, ...base });
    expect(m.courierMin).toBe(Math.round(percentile(ds.map((d) => d.waitMin!), 0.8)!));
    expect(m.drive[0].min).toBe(39); // p80 из 15..44
    expect(m.drive[1].min).toBeGreaterThanOrEqual(m.drive[0].min);
    expect(m.sample.measured).toBe(true);
  });

  it("сборка — медиана по флористу и размеру; большой без выборки = маленький + обычная разница", () => {
    const prep: PrepSample[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ floristId: "nastya", big: false, min: 40 + i })), // медиана 46
      ...Array.from({ length: 3 }, () => ({ floristId: "nastya", big: true, min: 100 })),
    ];
    const m = computeModel({ deliveries: [], prep, firstDispatch: [], workStart: {}, ...base });
    expect(m.prep.nastya.small).toBe(46);
    expect(m.prep.nastya.big).toBe(46 + 19);
    expect(prepMin(m, "nastya", false)).toBe(46);
    expect(prepMin(m, "unknown", true)).toBe(64);
  });

  it("разгон: первый вызов в загруженные дни − начало работы − сборка маленького, не меньше 0", () => {
    const firsts = Array.from({ length: 10 }, () => ({ floristId: "nastya", min: 12 * 60 + 9 }));
    const olga = Array.from({ length: 10 }, () => ({ floristId: "olga", min: 12 * 60 + 34 }));
    const prep: PrepSample[] = Array.from({ length: 12 }, () => ({ floristId: "nastya", big: false, min: 47 }));
    const m = computeModel({ deliveries: [], prep, firstDispatch: [...firsts, ...olga], workStart: { nastya: 600, olga: 720 }, ...base });
    expect(setupMin(m, "nastya")).toBe(129 - 47);
    expect(setupMin(m, "olga")).toBe(0);
    expect(setupMin(m, "new-florist")).toBe(DEFAULT_MODEL.setupDefault);
  });
});

describe("driveMin — дорога по расстоянию", () => {
  it("между серединами корзин — линейно, до первой — первая, дальше — с наклоном, но не больше 150", () => {
    expect(driveMin(DEFAULT_MODEL, 0.5)).toBe(28);
    expect(driveMin(DEFAULT_MODEL, 3)).toBe(Math.round(28 + (51 - 28) * (1.5 / 3)));
    expect(driveMin(DEFAULT_MODEL, 8)).toBe(63);
    expect(driveMin(DEFAULT_MODEL, 90)).toBe(150);
    expect(driveMin(DEFAULT_MODEL, null)).toBe(63);
  });
});
