import { describe, it, expect } from "vitest";
import { printCss } from "./printCss";
import { PRINT_DEFAULTS, geometry, type PrintLayout } from "@/modules/print/settings";

/**
 * CSS печати. Своих чисел у него больше нет — всё приходит из настроек, поэтому тесты
 * проверяют не константы (они в settings.test.ts), а что настройка ДОХОДИТ до листа.
 */
const css = (l: PrintLayout, over: Partial<typeof PRINT_DEFAULTS.wide> = {}) =>
  printCss(geometry(l, { ...PRINT_DEFAULTS[l], ...over }));

const LAYOUTS: PrintLayout[] = ["wide", "tall"];

describe("формат листа: US Letter, а не A4", () => {
  it("альбомная раскладка", () => {
    expect(css("wide")).toContain("size: Letter landscape");
    expect(css("wide")).not.toMatch(/A4/i);
    expect(css("wide")).toMatch(/\.sheet\s*\{[^}]*width:\s*11in/);
    expect(css("wide")).toMatch(/\.sheet\s*\{[^}]*height:\s*8\.5in/);
  });

  it("портретная раскладка", () => {
    expect(css("tall")).toContain("size: Letter portrait");
    expect(css("tall")).not.toMatch(/A4/i);
    expect(css("tall")).toMatch(/\.sheet\s*\{[^}]*width:\s*8\.5in/);
    expect(css("tall")).toMatch(/\.sheet\s*\{[^}]*height:\s*11in/);
  });

  it("в печати скрыты управляющие элементы (.no-print)", () => {
    for (const l of LAYOUTS) expect(css(l)).toMatch(/@media print\s*\{[^}]*\.no-print\s*\{\s*display:\s*none/);
  });
});

describe("сетка", () => {
  it("альбомная — два столбца на две строки", () => {
    expect(css("wide")).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(css("wide")).toMatch(/\.grid\s*\{[^}]*grid-template-rows:\s*1fr 1fr/);
  });

  it("портретная — один столбец на две строки", () => {
    expect(css("tall")).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(css("tall")).toMatch(/\.grid\s*\{[^}]*grid-template-rows:\s*1fr 1fr/);
  });

  it("линии разреза не занимают ячейку — иначе карточки разъехались бы по размеру", () => {
    expect(css("wide")).toMatch(/\.cut-v\s*\{[^}]*position:\s*absolute/);
    expect(css("wide")).toMatch(/\.cut-h\s*\{[^}]*position:\s*absolute/);
    expect(css("wide")).toMatch(/\.grid\s*\{[^}]*position:\s*relative/);
    // Ни ширины, ни высоты у самих ячеек нет: их задаёт только сетка.
    expect(css("wide")).not.toMatch(/\.card\s*\{[^}]*width:/);
    expect(css("wide")).not.toMatch(/\.card\s*\{[^}]*height:/);
  });

  it("линии разреза бледные — 20% непрозрачности, чтобы не спорить с текстом", () => {
    expect(css("wide")).toMatch(/\.cut-v\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
    expect(css("wide")).toMatch(/\.cut-h\s*\{[^}]*rgba\(100, 116, 139, 0\.2\)/);
  });

  it("лист и карточка защищены от разрыва между страницами принтера", () => {
    expect(css("wide")).toMatch(/\.sheet\s*\{[^}]*break-inside:\s*avoid/);
    expect(css("wide")).toMatch(/\.card\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("последний лист не тянет за собой пустой", () => {
    expect(css("wide")).toMatch(/\.sheet:last-child\s*\{[^}]*break-after:\s*auto/);
  });

  it("замерочный элемент переносит слова так же, как карточка", () => {
    // Иначе подобранный кегль не совпадёт с реальной вёрсткой на длинных ссылках.
    expect(css("wide")).toMatch(/\.measurer\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css("wide")).toMatch(/\.card\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe("настройки доходят до листа", () => {
  it("поле листа — отступом .sheet, а не @page: иначе оно сложилось бы дважды", () => {
    expect(css("tall", { safeMarginMils: 250 })).toMatch(/\.sheet\s*\{[^}]*padding:\s*0\.25in/);
    expect(css("tall")).toMatch(/@page\s*\{[^}]*margin:\s*0\s*;/);
  });

  it("поле для текста превращается в отступ карточки", () => {
    // Карточка портретной 720×480; текст 400×300 → поля (720−400)/2 и (480−300)/2.
    expect(css("tall", { textWidthPx: 400, textHeightPx: 300 })).toMatch(/\.card\s*\{[^}]*padding:\s*90px 160px;/);
  });

  it("кегль получателя и интерлиньяж записки берутся из настроек", () => {
    const out = css("wide", { recipientPt: 18, lineHeightPct: 175 });
    expect(out).toMatch(/\.rec-name\s*\{[^}]*font-size:\s*18pt/);
    expect(out).toMatch(/\.rec-addr\s*\{[^}]*font-size:\s*18pt/);
    expect(out).toMatch(/\.msg\s*\{[^}]*line-height:\s*1\.75/);
  });

  it("подъём получателя — поле снизу в двойном размере", () => {
    const g = geometry("tall", { ...PRINT_DEFAULTS.tall, recipientLiftPx: 30 });
    expect(printCss(g)).toMatch(new RegExp(`\\.card\\.recipient\\s*\\{[^}]*padding-bottom:\\s*${g.padY + 60}px`));
  });

  it("без подъёма получатель остаётся ровно по центру", () => {
    const g = geometry("wide", { ...PRINT_DEFAULTS.wide, recipientLiftPx: 0 });
    expect(printCss(g)).toMatch(new RegExp(`\\.card\\.recipient\\s*\\{[^}]*padding-bottom:\\s*${g.padY}px`));
  });
});

/**
 * Экранный показ. Лист задан в дюймах, и альбомные 11in (1056px) в окно уже не влезали —
 * правый край обрезался без прокрутки. Печати это касаться не должно.
 */
describe("масштаб листа на экране", () => {
  it("масштаб живёт только в @media screen", () => {
    for (const l of LAYOUTS) {
      expect(css(l)).toMatch(/@media screen\s*\{[^}]*\.doc\s*\{\s*zoom:\s*var\(--fit, 1\)/);
      expect(css(l)).not.toMatch(/@media print\s*\{[^}]*zoom:/);
    }
  });
});
