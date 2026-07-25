import { describe, it, expect } from "vitest";
import { toYmd, fromYmd, rangeLabel } from "./date-range-picker";

describe("конвертация дат календаря", () => {
  it("день не смещается при обратном преобразовании", () => {
    // Главный риск диапазона: через toISOString() дата у пользователя западнее UTC
    // уезжает на сутки назад. Здесь всё по календарным полям.
    for (const s of ["2026-07-01", "2026-07-25", "2026-12-31", "2026-01-01"]) {
      expect(toYmd(fromYmd(s)!)).toBe(s);
    }
  });

  it("полночь местного времени остаётся тем же днём", () => {
    const d = fromYmd("2026-07-25")!;
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(25);
    expect(d.getMonth()).toBe(6); // июль
  });

  it("мусор и пустое не превращаются в дату", () => {
    expect(fromYmd(undefined)).toBeUndefined();
    expect(fromYmd("")).toBeUndefined();
    expect(fromYmd("25.07.2026")).toBeUndefined();
    expect(fromYmd("2026-13-45")).toBeUndefined();
    // Date молча переполняет несуществующие даты — из URL так можно подсунуть чужой день.
    expect(fromYmd("2026-02-31")).toBeUndefined();
    expect(fromYmd("2026-00-10")).toBeUndefined();
  });
});

describe("подпись на кнопке", () => {
  const ph = "Даты доставки";

  it("пусто — плейсхолдер", () => {
    expect(rangeLabel({}, ph)).toBe(ph);
  });

  it("один день показывается одной датой, а не «X – X»", () => {
    const label = rangeLabel({ from: "2026-07-25", to: "2026-07-25" }, ph);
    expect(label).not.toContain("–");
    expect(label).toMatch(/25/);
  });

  it("диапазон — обе границы через тире", () => {
    const label = rangeLabel({ from: "2026-07-20", to: "2026-07-25" }, ph);
    expect(label).toContain("–");
    expect(label).toMatch(/20/);
    expect(label).toMatch(/25/);
  });

  it("одна граница читается как «с …» или «по …»", () => {
    expect(rangeLabel({ from: "2026-07-20" }, ph)).toMatch(/^с /);
    expect(rangeLabel({ to: "2026-07-25" }, ph)).toMatch(/^по /);
  });
});
