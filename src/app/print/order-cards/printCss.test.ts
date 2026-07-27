import { describe, it, expect } from "vitest";
import { PRINT_CSS, CARD_PADDING_PX } from "./printCss";

describe("print CSS (§14: 13,14)", () => {
  it("13) использует US Letter, а не A4", () => {
    expect(PRINT_CSS).toContain("@page");
    expect(PRINT_CSS).toContain("size: Letter portrait");
    expect(PRINT_CSS).not.toMatch(/A4/i);
  });

  it("половина = 8.5×5.5in, лист = 8.5×11in (в дюймах)", () => {
    expect(PRINT_CSS).toMatch(/\.half\s*\{[^}]*width:\s*8\.5in/);
    expect(PRINT_CSS).toMatch(/\.half\s*\{[^}]*height:\s*5\.5in/);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*width:\s*8\.5in/);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*height:\s*11in/);
  });

  it("14) в печати скрыты управляющие элементы (.no-print)", () => {
    expect(PRINT_CSS).toMatch(/@media print\s*\{[^}]*\.no-print\s*\{\s*display:\s*none/);
  });

  it("между половинами — пунктирная линия разреза", () => {
    expect(PRINT_CSS).toMatch(/\.cut-line\s*\{[^}]*dashed/);
  });
});

describe("поле открытки", () => {
  it("120px со всех сторон — одним значением, а не по сторонам", () => {
    expect(CARD_PADDING_PX).toBe(120);
    expect(PRINT_CSS).toMatch(/\.half\s*\{[^}]*padding:\s*120px;/);
  });

  it("поле листа нулевое — иначе отступ сложился бы дважды", () => {
    // @page margin: 0 → расстояние от края бумаги до текста задаёт только padding половины.
    expect(PRINT_CSS).toMatch(/@page\s*\{[^}]*margin:\s*0\s*;/);
  });

  it("текст помещается в половину: поля не съедают всю высоту", () => {
    const PX = 96;
    const halfH = 5.5 * PX;
    const msgAreaH = halfH - 2 * CARD_PADDING_PX - 12;
    // Даже самым крупным шрифтом (16pt ≈ 21.3px, line-height 1.4) остаётся место
    // на несколько строк — иначе короткая записка уезжала бы на второй лист.
    expect(msgAreaH).toBeGreaterThan(21.3 * 1.4 * 3);
  });

  it("ширина текста остаётся разумной для переноса слов", () => {
    const noteW = 8.5 * 96 - 2 * CARD_PADDING_PX;
    expect(noteW).toBeGreaterThan(400); // иначе длинные слова начнут рвать вёрстку
  });
});
