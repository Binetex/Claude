import { describe, it, expect } from "vitest";
import { PRINT_CSS, CARD_PADDING_PX, SAFE_MARGIN_IN, CELL_W_PX, CELL_H_PX, SHEET_W_IN, SHEET_H_IN } from "./printCss";

describe("print CSS (§14: 13,14)", () => {
  it("13) использует US Letter, а не A4", () => {
    expect(PRINT_CSS).toContain("@page");
    expect(PRINT_CSS).not.toMatch(/A4/i);
  });

  it("лист АЛЬБОМНЫЙ: 11in в ширину, 8.5in в высоту", () => {
    expect(PRINT_CSS).toContain("size: Letter landscape");
    expect(PRINT_CSS).not.toMatch(/portrait/);
    expect(SHEET_W_IN).toBe(11);
    expect(SHEET_H_IN).toBe(8.5);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*width:\s*11in/);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*height:\s*8\.5in/);
  });

  it("14) в печати скрыты управляющие элементы (.no-print)", () => {
    expect(PRINT_CSS).toMatch(/@media print\s*\{[^}]*\.no-print\s*\{\s*display:\s*none/);
  });

  it("линии разреза — пунктирные, по обеим осям", () => {
    expect(PRINT_CSS).toMatch(/\.cut-v\s*\{[^}]*dashed/);
    expect(PRINT_CSS).toMatch(/\.cut-h\s*\{[^}]*dashed/);
  });

  it("линии разреза бледные — 20% непрозрачности, чтобы не спорить с текстом", () => {
    expect(PRINT_CSS).toMatch(/\.cut-v\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
    expect(PRINT_CSS).toMatch(/\.cut-h\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
  });
});

describe("сетка 2×2", () => {
  it("четыре равные карточки: два столбца на две строки", () => {
    expect(PRINT_CSS).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(PRINT_CSS).toMatch(/\.grid\s*\{[^}]*grid-template-rows:\s*1fr 1fr/);
  });

  it("карточка — ровно четверть печатной области", () => {
    expect(CELL_W_PX).toBe(((SHEET_W_IN - 2 * SAFE_MARGIN_IN) / 2) * 96);
    expect(CELL_H_PX).toBe(((SHEET_H_IN - 2 * SAFE_MARGIN_IN) / 2) * 96);
    expect(CELL_W_PX).toBe(480); // 5in
    expect(CELL_H_PX).toBe(360); // 3.75in
  });

  it("линии разреза не занимают ячейку — иначе карточки разъехались бы по размеру", () => {
    // Абсолютное позиционирование выносит их из потока сетки.
    expect(PRINT_CSS).toMatch(/\.cut-v\s*\{[^}]*position:\s*absolute/);
    expect(PRINT_CSS).toMatch(/\.cut-h\s*\{[^}]*position:\s*absolute/);
    expect(PRINT_CSS).toMatch(/\.grid\s*\{[^}]*position:\s*relative/);
    // Ни ширины, ни высоты у самих ячеек нет: их задаёт только сетка.
    expect(PRINT_CSS).not.toMatch(/\.card\s*\{[^}]*width:/);
    expect(PRINT_CSS).not.toMatch(/\.card\s*\{[^}]*height:/);
  });
});

describe("безопасные поля печати", () => {
  it("полдюйма со всех сторон — непечатаемая кромка принтера ничего не срежет", () => {
    // Бытовые принтеры не печатают у краёв: обычно 0.16–0.25in, у части inkjet до 0.5in.
    expect(SAFE_MARGIN_IN).toBeGreaterThanOrEqual(0.5);
    expect(PRINT_CSS).toMatch(new RegExp(`\\.sheet\\s*\\{[^}]*padding:\\s*${SAFE_MARGIN_IN}in`));
  });

  it("поле листа задано отступом, а не @page — иначе оно сложилось бы дважды", () => {
    expect(PRINT_CSS).toMatch(/@page\s*\{[^}]*margin:\s*0\s*;/);
  });

  it("вся сетка помещается в печатную область", () => {
    // Две карточки в ряд и две в столбец не должны выходить за 8.5×11in с полями.
    expect((2 * CELL_W_PX) / 96 + 2 * SAFE_MARGIN_IN).toBeLessThanOrEqual(SHEET_W_IN);
    expect((2 * CELL_H_PX) / 96 + 2 * SAFE_MARGIN_IN).toBeLessThanOrEqual(SHEET_H_IN);
  });
});

describe("поле карточки", () => {
  it("одним значением со всех сторон, а не по сторонам", () => {
    expect(CARD_PADDING_PX).toBe(44);
    expect(PRINT_CSS).toMatch(/\.card\s*\{[^}]*padding:\s*44px;/);
  });

  it("текст не упирается в линию реза", () => {
    // Ножницы редко идут точно по линии — нужен заметный зазор, около полусантиметра.
    expect(CARD_PADDING_PX).toBeGreaterThanOrEqual(40);
  });

  it("текст помещается в карточку: поля не съедают всю высоту", () => {
    const msgAreaH = CELL_H_PX - 2 * CARD_PADDING_PX - 12;
    // Даже самым крупным шрифтом (16pt ≈ 21.3px, line-height 1.4) остаётся место
    // на несколько строк — иначе короткая записка уезжала бы на вторую карточку.
    expect(msgAreaH).toBeGreaterThan(21.3 * 1.4 * 6);
  });

  it("лист и карточка защищены от разрыва между страницами принтера", () => {
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*break-inside:\s*avoid/);
    expect(PRINT_CSS).toMatch(/\.card\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("последний лист не тянет за собой пустой", () => {
    expect(PRINT_CSS).toMatch(/\.sheet:last-child\s*\{[^}]*break-after:\s*auto/);
  });

  it("замерочный элемент переносит слова так же, как карточка", () => {
    // Иначе подобранный кегль не совпадёт с реальной вёрсткой на длинных ссылках.
    expect(PRINT_CSS).toMatch(/\.measurer\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(PRINT_CSS).toMatch(/\.card\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("ширина текста остаётся разумной для переноса слов", () => {
    const noteW = CELL_W_PX - 2 * CARD_PADDING_PX;
    expect(noteW).toBeGreaterThan(280); // иначе длинные слова начнут рвать вёрстку
  });
});
