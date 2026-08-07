import { describe, it, expect } from "vitest";
import {
  PRINT_DEFAULTS,
  PRINT_FIELDS,
  PRINT_LIMITS,
  SHEET_FORMAT,
  cellSize,
  clampSettings,
  geometry,
  kindToLayout,
  layoutToKind,
  sheetWidthPx,
  type PrintLayout,
  type PrintSettings,
} from "./settings";

const LAYOUTS: PrintLayout[] = ["wide", "tall"];
const def = (l: PrintLayout): PrintSettings => ({ ...PRINT_DEFAULTS[l] });

/**
 * Настройки печати заменили зашитые в код числа. Значения по умолчанию обязаны давать
 * РОВНО тот лист, что печатался раньше: настройка — это возможность изменить, а не
 * повод молча поменять всем внешний вид записок.
 */
describe("значения по умолчанию = прежняя вёрстка", () => {
  it("альбомная: карточка 480×360, поля 44px, кегль 16/10pt", () => {
    const g = geometry("wide", def("wide"));
    expect(g.cell).toEqual({ w: 480, h: 360 });
    expect(g.padX).toBe(44);
    expect(g.settings.basePt).toBe(16);
    expect(g.settings.minPt).toBe(10);
  });

  it("портретная: карточка 720×480, колонка текста 480px, кегль 14/8pt", () => {
    const g = geometry("tall", def("tall"));
    expect(g.cell).toEqual({ w: 720, h: 480 });
    expect(g.padX).toBe(120);
    expect(g.settings.textWidthPx).toBe(480);
    expect(g.settings.basePt).toBe(14);
    expect(g.settings.minPt).toBe(8);
  });

  it("блок получателя поднят на 80px только на портретной", () => {
    // Подъём задан полем СНИЗУ в двойном размере: содержимое центрируется.
    const tall = geometry("tall", def("tall"));
    expect(tall.recipientPadBottom).toBe(tall.padY + 160);
    const wide = geometry("wide", def("wide"));
    expect(wide.recipientPadBottom).toBe(wide.padY);
  });

  it("лист остаётся US Letter, обе ориентации", () => {
    expect(SHEET_FORMAT.wide).toMatchObject({ w: 11, h: 8.5, cols: 2, rows: 2 });
    expect(SHEET_FORMAT.tall).toMatchObject({ w: 8.5, h: 11, cols: 1, rows: 2 });
    expect(sheetWidthPx("wide")).toBe(1056);
    expect(sheetWidthPx("tall")).toBe(816);
  });
});

/**
 * Отступ карточки — не отдельная настройка, а остаток: карточка задана листом, значит
 * поле для текста и отступ это одно число с двух сторон. Форма показывает оба, но
 * вводится одно, иначе они спорили бы друг с другом.
 */
describe("отступ выводится из поля для текста", () => {
  it("шире поле — меньше отступ, сумма всегда равна карточке", () => {
    for (const l of LAYOUTS) {
      const g = geometry(l, { ...def(l), textWidthPx: 300, textHeightPx: 200 });
      expect(g.padX * 2 + 300).toBe(g.cell.w);
      expect(g.padY * 2 + 200).toBe(g.cell.h);
    }
  });

  it("поле листа уменьшает карточку, а с ней и место под текст", () => {
    const tight = cellSize("wide", { ...def("wide"), safeMarginMils: 1000 });
    const loose = cellSize("wide", { ...def("wide"), safeMarginMils: 0 });
    expect(tight.w).toBeLessThan(loose.w);
    expect(tight.h).toBeLessThan(loose.h);
  });
});

/**
 * Границы — не косметика. Поле шире карточки даёт отрицательный отступ, кегль в 200pt —
 * записку, разорванную на десяток листов. Форму можно обойти, поэтому режется на сервере.
 */
describe("приведение к допустимому", () => {
  it("каждое поле имеет границы и умолчание внутри них", () => {
    for (const l of LAYOUTS) {
      for (const key of PRINT_FIELDS) {
        const lim = PRINT_LIMITS[key];
        expect(lim.min).toBeLessThan(lim.max);
        expect(PRINT_DEFAULTS[l][key]).toBeGreaterThanOrEqual(lim.min);
        expect(PRINT_DEFAULTS[l][key]).toBeLessThanOrEqual(lim.max);
      }
    }
  });

  it("умолчания не подрезаются — они уже допустимы", () => {
    for (const l of LAYOUTS) expect(clampSettings(l, def(l))).toEqual(PRINT_DEFAULTS[l]);
  });

  it("поле для текста не бывает шире карточки", () => {
    for (const l of LAYOUTS) {
      const s = clampSettings(l, { ...def(l), textWidthPx: 5000, textHeightPx: 5000 });
      const cell = cellSize(l, s);
      expect(s.textWidthPx).toBeLessThanOrEqual(cell.w);
      expect(s.textHeightPx).toBeLessThanOrEqual(cell.h);
      // и отступ от этого не уходит в минус
      const g = geometry(l, s);
      expect(g.padX).toBeGreaterThanOrEqual(0);
      expect(g.padY).toBeGreaterThanOrEqual(0);
    }
  });

  it("пол кегля не поднимается выше потолка", () => {
    // Иначе подбор размера остался бы без диапазона.
    const s = clampSettings("tall", { ...def("tall"), basePt: 10, minPt: 30 });
    expect(s.minPt).toBeLessThanOrEqual(s.basePt);
    expect(s.basePt).toBe(10); // двигается именно пол: потолок владелец видит на коротких записках
  });

  it("подъём получателя не выкидывает блок за край карточки", () => {
    const g = geometry("tall", { ...def("tall"), recipientLiftPx: 300 });
    expect(g.recipientPadBottom).toBeLessThan(g.cell.h);
  });

  it("мусор вместо числа не ломает печать", () => {
    const s = clampSettings("wide", { ...def("wide"), basePt: NaN, textWidthPx: -50 } as PrintSettings);
    expect(Number.isFinite(s.basePt)).toBe(true);
    expect(s.textWidthPx).toBeGreaterThanOrEqual(PRINT_LIMITS.textWidthPx.min);
  });

  it("дробные значения округляются — в БД целые", () => {
    const s = clampSettings("wide", { ...def("wide"), textWidthPx: 300.7, lineHeightPct: 140.4 });
    expect(s.textWidthPx).toBe(301);
    expect(s.lineHeightPct).toBe(140);
  });
});

describe("раскладка ↔ значение в БД", () => {
  it("перевод в обе стороны без потерь", () => {
    for (const l of LAYOUTS) expect(kindToLayout(layoutToKind(l))).toBe(l);
  });
});
