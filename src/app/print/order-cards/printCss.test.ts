import { describe, it, expect } from "vitest";
import { printCss, cellSize, textArea, SAFE_MARGIN_IN, SHEET_IN } from "./printCss";

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

describe("поля карточки", () => {
  it("альбомная — 44px со всех сторон", () => {
    expect(printCss("wide")).toMatch(/\.card\s*\{[^}]*padding:\s*44px 44px;/);
  });

  it("портретная — по бокам ВДВОЕ шире, сверху и снизу столько же", () => {
    expect(printCss("tall")).toMatch(/\.card\s*\{[^}]*padding:\s*44px 88px;/);
    expect(SHEET_IN.tall.padX).toBe(2 * SHEET_IN.wide.padX);
    expect(SHEET_IN.tall.padY).toBe(SHEET_IN.wide.padY);
  });

  it("текст не упирается в линию реза", () => {
    // Ножницы редко идут точно по линии — нужен заметный зазор, около полусантиметра.
    for (const l of ["wide", "tall"] as const) {
      expect(SHEET_IN[l].padX).toBeGreaterThanOrEqual(40);
      expect(SHEET_IN[l].padY).toBeGreaterThanOrEqual(40);
    }
  });

  it("текста помещается больше на портретной карточке, чем на альбомной", () => {
    const a = (l: "wide" | "tall") => textArea(l).width * textArea(l).height;
    // Ради этого портретную раскладку и вернули: записка получается «на полстраницы».
    expect(a("tall")).toBeGreaterThan(a("wide") * 1.5);
  });

  it("даже на альбомной карточке остаётся место на несколько строк", () => {
    // Самым крупным шрифтом (16pt ≈ 21.3px, line-height 1.4).
    expect(textArea("wide").height).toBeGreaterThan(21.3 * 1.4 * 6);
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

/**
 * Кегль записки. У портретной карточки он ниже с обеих сторон: сверху — чтобы текст не
 * выглядел плакатом на большом листе, снизу — чтобы длинная записка помещалась ОДНИМ куском.
 * Именно пол решает, поедет ли продолжение на второй лист.
 */
describe("диапазон кегля", () => {
  it("портретная: потолок 14pt, пол 8pt", () => {
    expect(SHEET_IN.tall.basePt).toBe(14);
    expect(SHEET_IN.tall.minPt).toBe(8);
  });

  it("альбомная не меняется: потолок 16pt, пол 10pt", () => {
    expect(SHEET_IN.wide.basePt).toBe(16);
    expect(SHEET_IN.wide.minPt).toBe(10);
  });

  it("у портретной обе границы ниже, чем у альбомной", () => {
    expect(SHEET_IN.tall.basePt).toBeLessThan(SHEET_IN.wide.basePt);
    expect(SHEET_IN.tall.minPt).toBeLessThan(SHEET_IN.wide.minPt);
  });

  it("на минимальном кегле в портрет влезает БОЛЬШЕ, чем в альбом", () => {
    // То, ради чего пол и опущен: разрыв записки на второй лист должен стать реже, а не чаще.
    const capacity = (l: "wide" | "tall") => {
      const a = textArea(l);
      const px = (SHEET_IN[l].minPt * 96) / 72;
      const lines = Math.floor(a.height / (px * 1.4));
      const perLine = Math.floor(a.width / (px * 0.5)); // грубая оценка ширины символа
      return lines * perLine;
    };
    expect(capacity("tall")).toBeGreaterThan(capacity("wide"));
  });
});
