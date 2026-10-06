import { describe, it, expect } from "vitest";
import {
  PRINT_DEFAULTS,
  PRINT_FIELDS,
  PRINT_LIMITS,
  SHEET_FORMAT,
  blockCenters,
  cellSize,
  clampSettings,
  cmOfMils,
  cmOfPx,
  geometry,
  milsOfCm,
  pxOfCm,
  withBlockCenters,
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

  it("блок получателя поднят на 80px только на портретной, текст открытки на месте", () => {
    const tall = geometry("tall", def("tall"));
    expect(tall.settings.recipientLiftPx).toBe(80);
    const wide = geometry("wide", def("wide"));
    expect(wide.settings.recipientLiftPx).toBe(0);
    // Без сдвига текст подбирается ровно под поле для текста — как и раньше.
    for (const g of [tall, wide]) {
      expect(g.settings.messageDropPx).toBe(0);
      expect(g.messageHeightPx).toBe(g.settings.textHeightPx);
    }
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

  it("подъём получателя не выкидывает блок за верх карточки", () => {
    for (const l of LAYOUTS) {
      const g = geometry(l, { ...def(l), recipientLiftPx: 300 });
      // Над серединой поднятого блока остаётся место на его пять строк.
      expect(g.cell.h / 2 - g.settings.recipientLiftPx).toBeGreaterThanOrEqual(50);
      expect(g.settings.recipientLiftPx).toBeGreaterThan(0);
    }
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

/**
 * Положение блоков на листе (владелец 05.10.2026): на бумаге получатель стоял слишком низко,
 * а текст открытки слишком высоко — «где-то на 4 сантиметра». Двигает владелец сам.
 */
describe("положение на листе: получатель вверх, текст открытки вниз", () => {
  const CM4 = Math.round((4 / 2.54) * 96); // 151px

  it("на портретной оба блока отодвигаются от середины на 4 см", () => {
    const s = clampSettings("tall", { ...def("tall"), recipientLiftPx: CM4, messageDropPx: CM4 });
    expect(s.recipientLiftPx).toBe(CM4);
    expect(s.messageDropPx).toBe(CM4);
    expect(geometry("tall", s).messageHeightPx).toBe(480 - 2 * CM4);
  });

  it("опущенный текст не уезжает за низ: место под него ужимается на двойной сдвиг", () => {
    for (const l of LAYOUTS) {
      for (const drop of [0, 40, CM4, 1000]) {
        const g = geometry(l, { ...def(l), messageDropPx: drop });
        // Нижний край самого высокого текста: середина карточки + половина места + сдвиг.
        expect(g.cell.h / 2 + g.messageHeightPx / 2 + g.settings.messageDropPx).toBeLessThanOrEqual(g.cell.h);
        expect(g.messageHeightPx).toBeLessThanOrEqual(g.settings.textHeightPx);
        expect(g.messageHeightPx).toBeGreaterThanOrEqual(PRINT_LIMITS.textHeightPx.min);
      }
    }
  });

  it("сдвиг сверх возможного подрезается, а не ломает лист — в обе стороны", () => {
    // Карточка альбомной 360px: места под текст остаётся не меньше минимального поля.
    expect(clampSettings("wide", { ...def("wide"), messageDropPx: 300 }).messageDropPx).toBe(150);
    expect(clampSettings("wide", { ...def("wide"), messageDropPx: -300 }).messageDropPx).toBe(-150);
  });

  it("текст открытки можно и поднять: место ужимается так же, за верх он не уходит", () => {
    for (const l of LAYOUTS) {
      const g = geometry(l, { ...def(l), messageDropPx: -CM4 });
      expect(g.cell.h / 2 - g.messageHeightPx / 2 + g.settings.messageDropPx).toBeGreaterThanOrEqual(0);
    }
  });

  it("получателя можно и опустить — до низа своей половины, не дальше", () => {
    for (const l of LAYOUTS) {
      const g = geometry(l, { ...def(l), recipientLiftPx: -300 });
      expect(g.cell.h / 2 + g.settings.recipientLiftPx).toBeGreaterThanOrEqual(50);
      expect(g.settings.recipientLiftPx).toBeLessThan(0);
    }
  });
});

/**
 * Форма показывает положение блоков от ВЕРХНЕГО КРАЯ листа и в сантиметрах (владелец 05.10.2026:
 * «мне проще смотреть отступы от верхней границы и писать сразу см»), а в базе — сдвиги от
 * середины своей половины в px. Пересчёт обязан сходиться в обе стороны.
 */
describe("от верхнего края листа, в сантиметрах", () => {
  const CM4 = Math.round((4 / 2.54) * 96); // 151px

  it("сантиметры ↔ px и тысячные дюйма", () => {
    expect(pxOfCm(4)).toBe(151);
    expect(cmOfPx(151)).toBeCloseTo(3.995, 2);
    expect(milsOfCm(1.27)).toBe(500);
    expect(cmOfMils(500)).toBeCloseTo(1.27, 5);
  });

  it("портретная по умолчанию: получатель на 208px от верха, текст открытки на 768px", () => {
    // Поле листа 0,5in = 48px, карточка 480px: середина верхней половины 288px − подъём 80.
    expect(blockCenters("tall", def("tall"))).toEqual({ recipient: 208, message: 768 });
  });

  it("поставили середину текста на 4 см ниже — в базе ровно такой сдвиг", () => {
    const moved = withBlockCenters("tall", def("tall"), { message: 768 + CM4 });
    expect(moved.messageDropPx).toBe(CM4);
    expect(moved.recipientLiftPx).toBe(80); // второй блок не трогаем
    expect(blockCenters("tall", moved).message).toBe(768 + CM4);
  });

  it("поле листа поменяли — блоки остаются на своём месте листа", () => {
    const s = withBlockCenters("tall", def("tall"), { recipient: 150, message: 900 });
    const wider = withBlockCenters("tall", { ...s, safeMarginMils: 300 }, blockCenters("tall", s));
    // Сдвиги в базе — целые px, поэтому совпадение в пределах пикселя (сотые доли миллиметра).
    const c = blockCenters("tall", wider);
    expect(Math.abs(c.recipient - 150)).toBeLessThan(1);
    expect(Math.abs(c.message - 900)).toBeLessThan(1);
  });
});

describe("раскладка ↔ значение в БД", () => {
  it("перевод в обе стороны без потерь", () => {
    for (const l of LAYOUTS) expect(kindToLayout(layoutToKind(l))).toBe(l);
  });
});
