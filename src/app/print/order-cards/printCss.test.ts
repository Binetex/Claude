import { describe, it, expect } from "vitest";
import { printCss, cellSize, CARD_PADDING_PX, SAFE_MARGIN_IN, SHEET_IN } from "./printCss";

/**
 * Раскладок две, и выбирает её настройка флориста:
 *  - «Только своя цена» → альбомный лист, 4 карточки (экономит бумагу);
 *  - «Полная цена» → портретный лист, 2 карточки (как печатали до перехода на 2×2).
 */
describe("печать: US Letter, а не A4", () => {
  it("альбомная раскладка", () => {
    const css = printCss("wide");
    expect(css).toContain("size: Letter landscape");
    expect(css).not.toMatch(/A4/i);
    expect(css).toMatch(/\.sheet\s*\{[^}]*width:\s*11in/);
    expect(css).toMatch(/\.sheet\s*\{[^}]*height:\s*8\.5in/);
  });

  it("портретная раскладка", () => {
    const css = printCss("tall");
    expect(css).toContain("size: Letter portrait");
    expect(css).not.toMatch(/A4/i);
    expect(css).toMatch(/\.sheet\s*\{[^}]*width:\s*8\.5in/);
    expect(css).toMatch(/\.sheet\s*\{[^}]*height:\s*11in/);
  });

  it("в печати скрыты управляющие элементы (.no-print)", () => {
    for (const l of ["wide", "tall"] as const) {
      expect(printCss(l)).toMatch(/@media print\s*\{[^}]*\.no-print\s*\{\s*display:\s*none/);
    }
  });
});

describe("сетка", () => {
  it("альбомная — два столбца на две строки, четыре равные карточки", () => {
    const css = printCss("wide");
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-rows:\s*1fr 1fr/);
    expect(cellSize("wide")).toEqual({ w: 480, h: 360 }); // 5 × 3.75in
  });

  it("портретная — один столбец на две строки, карточка вчетверо больше", () => {
    const css = printCss("tall");
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-rows:\s*1fr 1fr/);
    expect(cellSize("tall")).toEqual({ w: 720, h: 480 }); // 7.5 × 5in
  });

  it("карточка — печатная область, поделённая на сетку", () => {
    for (const l of ["wide", "tall"] as const) {
      const s = SHEET_IN[l];
      const c = cellSize(l);
      expect(c.w).toBe(((s.w - 2 * SAFE_MARGIN_IN) / s.cols) * 96);
      expect(c.h).toBe(((s.h - 2 * SAFE_MARGIN_IN) / s.rows) * 96);
    }
  });

  it("вся сетка помещается в печатную область", () => {
    for (const l of ["wide", "tall"] as const) {
      const s = SHEET_IN[l];
      const c = cellSize(l);
      expect((s.cols * c.w) / 96 + 2 * SAFE_MARGIN_IN).toBeLessThanOrEqual(s.w);
      expect((s.rows * c.h) / 96 + 2 * SAFE_MARGIN_IN).toBeLessThanOrEqual(s.h);
    }
  });

  it("линии разреза не занимают ячейку — иначе карточки разъехались бы по размеру", () => {
    const css = printCss("wide");
    expect(css).toMatch(/\.cut-v\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.cut-h\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.grid\s*\{[^}]*position:\s*relative/);
    // Ни ширины, ни высоты у самих ячеек нет: их задаёт только сетка.
    expect(css).not.toMatch(/\.card\s*\{[^}]*width:/);
    expect(css).not.toMatch(/\.card\s*\{[^}]*height:/);
  });

  it("линии разреза бледные — 20% непрозрачности, чтобы не спорить с текстом", () => {
    const css = printCss("wide");
    expect(css).toMatch(/\.cut-v\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
    expect(css).toMatch(/\.cut-h\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
  });
});

describe("безопасные поля печати", () => {
  it("полдюйма со всех сторон — непечатаемая кромка принтера ничего не срежет", () => {
    // Бытовые принтеры не печатают у краёв: обычно 0.16–0.25in, у части inkjet до 0.5in.
    expect(SAFE_MARGIN_IN).toBeGreaterThanOrEqual(0.5);
    for (const l of ["wide", "tall"] as const) {
      expect(printCss(l)).toMatch(new RegExp(`\\.sheet\\s*\\{[^}]*padding:\\s*${SAFE_MARGIN_IN}in`));
    }
  });

  it("поле листа задано отступом, а не @page — иначе оно сложилось бы дважды", () => {
    expect(printCss("wide")).toMatch(/@page\s*\{[^}]*margin:\s*0\s*;/);
  });
});

describe("поле карточки", () => {
  it("одним значением со всех сторон, а не по сторонам", () => {
    expect(CARD_PADDING_PX).toBe(44);
    expect(printCss("wide")).toMatch(/\.card\s*\{[^}]*padding:\s*44px;/);
  });

  it("текст не упирается в линию реза", () => {
    // Ножницы редко идут точно по линии — нужен заметный зазор, около полусантиметра.
    expect(CARD_PADDING_PX).toBeGreaterThanOrEqual(40);
  });

  it("текста помещается больше на портретной карточке, чем на альбомной", () => {
    const area = (l: "wide" | "tall") => {
      const c = cellSize(l);
      return (c.w - 2 * CARD_PADDING_PX) * (c.h - 2 * CARD_PADDING_PX - 12);
    };
    // Ради этого портретную раскладку и вернули: записка получается «на полстраницы».
    expect(area("tall")).toBeGreaterThan(area("wide") * 2);
  });

  it("даже на альбомной карточке остаётся место на несколько строк", () => {
    const c = cellSize("wide");
    const msgAreaH = c.h - 2 * CARD_PADDING_PX - 12;
    // Самым крупным шрифтом (16pt ≈ 21.3px, line-height 1.4).
    expect(msgAreaH).toBeGreaterThan(21.3 * 1.4 * 6);
  });

  it("лист и карточка защищены от разрыва между страницами принтера", () => {
    const css = printCss("wide");
    expect(css).toMatch(/\.sheet\s*\{[^}]*break-inside:\s*avoid/);
    expect(css).toMatch(/\.card\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("последний лист не тянет за собой пустой", () => {
    expect(printCss("wide")).toMatch(/\.sheet:last-child\s*\{[^}]*break-after:\s*auto/);
  });

  it("замерочный элемент переносит слова так же, как карточка", () => {
    // Иначе подобранный кегль не совпадёт с реальной вёрсткой на длинных ссылках.
    const css = printCss("wide");
    expect(css).toMatch(/\.measurer\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.card\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
