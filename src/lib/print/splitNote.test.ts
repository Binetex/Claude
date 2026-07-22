import { describe, it, expect } from "vitest";
import { splitCardIntoParts, type Measure } from "./splitNote";

// Детерминированный мок замера: перенос слов на CHARS_PER_LINE, явные \n учитываются.
const CHARS_PER_LINE = 20;
const LINE_PX = 20;
const measure: Measure = (text) => {
  let lines = 0;
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines += 1;
      continue;
    }
    let len = 0;
    let lineCount = 1;
    for (const w of words) {
      if (len === 0) len = w.length;
      else if (len + 1 + w.length <= CHARS_PER_LINE) len += 1 + w.length;
      else {
        lineCount++;
        len = w.length;
      }
    }
    lines += lineCount;
  }
  return lines * LINE_PX;
};

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

describe("splitCardIntoParts", () => {
  it("1) короткий текст → одна часть", () => {
    const parts = splitCardIntoParts("Happy Birthday Sarah", { firstHeightPx: 200, contHeightPx: 200 }, measure);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe("Happy Birthday Sarah");
  });

  it("4) длинный текст → разбивается на 2 части, каждая в пределах бюджета", () => {
    const text = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" "); // 12 слов
    const parts = splitCardIntoParts(text, { firstHeightPx: 3 * LINE_PX, contHeightPx: 3 * LINE_PX }, measure);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(measure(p)).toBeLessThanOrEqual(3 * LINE_PX);
  });

  it("5) очень длинный текст → 3+ части", () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const parts = splitCardIntoParts(text, { firstHeightPx: 2 * LINE_PX, contHeightPx: 2 * LINE_PX }, measure);
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it("6,7) текст не обрезается и порядок сохраняется (склейка частей = исходные слова по порядку)", () => {
    const text = "Dear Sarah,\n\nWishing you joy and flowers today and always. With love, from everyone who adores you.";
    const parts = splitCardIntoParts(text, { firstHeightPx: 2 * LINE_PX, contHeightPx: 2 * LINE_PX }, measure);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap(wordsOf)).toEqual(wordsOf(text)); // все слова, в том же порядке, без потерь
  });

  it("не разрывает слова (в частях нет обрезков — каждое слово целиком из исходного набора)", () => {
    const text = "supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultramicroscopic";
    const parts = splitCardIntoParts(text, { firstHeightPx: 1 * LINE_PX, contHeightPx: 1 * LINE_PX }, measure);
    const orig = new Set(wordsOf(text));
    for (const p of parts) for (const w of wordsOf(p)) expect(orig.has(w)).toBe(true);
  });

  it("первая часть меряется по firstHeightPx, продолжения — по contHeightPx (меньше)", () => {
    const text = Array.from({ length: 10 }, (_, i) => `x${i}`).join(" ");
    const parts = splitCardIntoParts(text, { firstHeightPx: 5 * LINE_PX, contHeightPx: 1 * LINE_PX }, measure);
    expect(measure(parts[0])).toBeLessThanOrEqual(5 * LINE_PX);
    for (let i = 1; i < parts.length; i++) expect(measure(parts[i])).toBeLessThanOrEqual(1 * LINE_PX);
  });

  it("пустой текст → пустой массив частей", () => {
    expect(splitCardIntoParts("", { firstHeightPx: 100, contHeightPx: 100 }, measure)).toEqual([]);
  });
});
