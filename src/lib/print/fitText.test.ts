import { describe, it, expect } from "vitest";
import { fitFontPt, type MeasureAt } from "./fitText";

/**
 * Детерминированный «рендер»: высота = число строк × высота строки.
 * Строки считаем по ширине области и средней ширине символа при данном кегле — этого
 * достаточно, чтобы воспроизвести поведение переноса без настоящего DOM.
 */
function makeMeasure(areaWidthPx: number): MeasureAt {
  return (text, fontPt) => {
    const charW = fontPt * 0.5; // приблизительная ширина символа
    const lineH = fontPt * 1.4 * (96 / 72); // pt → px, интерлиньяж 1.4
    const perLine = Math.max(1, Math.floor(areaWidthPx / charW));
    const lines = text
      .split("\n")
      .reduce((sum, para) => sum + Math.max(1, Math.ceil(para.length / perLine)), 0);
    return lines * lineH;
  };
}

const AREA_W = 576; // 8.5in − 2×120px
const AREA_H = 276; // 5.5in − 2×120px − 12
const opts = { basePt: 16, minPt: 12, areaHeightPx: AREA_H };
const measure = makeMeasure(AREA_W);

describe("подбор размера шрифта открытки", () => {
  it("короткая записка печатается базовым размером", () => {
    const r = fitFontPt("С днём рождения!", opts, measure);
    expect(r).toEqual({ fontPt: 16, fits: true });
  });

  it("средний текст тоже остаётся на базовом, пока помещается", () => {
    const r = fitFontPt("Дорогая Мария! Поздравляю с праздником и желаю счастья.", opts, measure);
    expect(r.fontPt).toBe(16);
    expect(r.fits).toBe(true);
  });

  it("длинный текст уменьшается, но помещается на одной половине", () => {
    // Раньше такой текст уезжал на вторую страницу базовым кеглем.
    const long = "Пусть этот день будет наполнен светом и радостью. ".repeat(16); // ~800 симв.
    const r = fitFontPt(long, opts, measure);
    expect(r.fits).toBe(true);
    expect(r.fontPt).toBeLessThan(16);
    expect(r.fontPt).toBeGreaterThanOrEqual(12);
    // Проверяем именно фактическую высоту, а не только флаг.
    expect(measure(long, r.fontPt)).toBeLessThanOrEqual(AREA_H);
  });

  it("выбирается САМЫЙ КРУПНЫЙ подходящий размер, а не первый попавшийся", () => {
    const long = "Пусть этот день будет наполнен светом и радостью. ".repeat(16); // ~800 симв.
    const r = fitFontPt(long, opts, measure);
    // На размер больше подобранного текст уже не помещается.
    expect(measure(long, r.fontPt + 1)).toBeGreaterThan(AREA_H);
  });

  it("многоабзацный текст учитывает переносы строк", () => {
    const paragraphs = "Дорогая Мария!\n\nПоздравляю тебя.\n\nС любовью,\nИван";
    const r = fitFontPt(paragraphs, opts, measure);
    expect(r.fits).toBe(true);
    expect(measure(paragraphs, r.fontPt)).toBeLessThanOrEqual(AREA_H);
  });

  it("текст, не влезающий даже минимальным кеглем, отдаётся на перенос — но не теряется", () => {
    const huge = "Очень длинное поздравление со множеством пожеланий. ".repeat(40);
    const r = fitFontPt(huge, opts, measure);
    expect(r.fits).toBe(false); // дальше вызывающий код разобьёт текст на части
    expect(r.fontPt).toBe(12); // ниже минимума не опускаемся
  });

  it("одно очень длинное слово (например URL) не роняет подбор", () => {
    const url = "https://example.com/" + "a".repeat(300);
    const r = fitFontPt(url, opts, measure);
    expect(r.fontPt).toBeGreaterThanOrEqual(12);
    expect(r.fontPt).toBeLessThanOrEqual(16);
  });

  it("пустой текст остаётся на базовом размере", () => {
    expect(fitFontPt("", opts, measure)).toEqual({ fontPt: 16, fits: true });
  });

  it("число шагов ограничено диапазоном — цикл не может стать бесконечным", () => {
    let calls = 0;
    const counting: MeasureAt = (t, pt) => {
      calls++;
      return measure(t, pt);
    };
    fitFontPt("x".repeat(5000), opts, counting);
    expect(calls).toBeLessThanOrEqual(16 - 12 + 1);
  });

  it("минимум выше базового не ломает подбор", () => {
    const r = fitFontPt("текст", { basePt: 12, minPt: 16, areaHeightPx: AREA_H }, measure);
    expect(r.fontPt).toBe(12);
  });
});
