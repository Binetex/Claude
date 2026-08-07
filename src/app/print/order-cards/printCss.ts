/**
 * Печатный CSS записок. Все числа приходят ИЗВНЕ — из `PrintGeometry`, которую собирает
 * `modules/print/settings.ts` по настройкам владельца. Своих констант здесь больше нет:
 * стоит завести хоть одну, и она немедленно разойдётся с формой в админке.
 *
 * Ту же геометрию читает PrintDocument, когда считает область для замера текста. Разъедься
 * замер с вёрсткой — подобранный кегль не совпадёт с реальным, и длинный текст переполнит
 * карточку.
 */
import type { PrintGeometry } from "@/modules/print/settings";

export type { PrintLayout } from "@/modules/print/settings";

/**
 * Линии реза — вспомогательные, а не часть открытки: их видно ровно настолько, чтобы
 * попасть ножницами. Отсюда 20% непрозрачности вместо сплошного серого.
 */
const CUT_LINE_COLOR = "rgba(100, 116, 139, 0.2)";

/**
 * US Letter (НЕ A4), ориентация и сетка — по раскладке.
 *
 * Заказ занимает СТОЛБЕЦ: сверху получатель, снизу текст открытки. В альбомной раскладке
 * столбцов два, и вертикальный рез посередине отделяет заказы друг от друга; в портретной
 * столбец один — лист и есть заказ.
 */
export function printCss(g: PrintGeometry): string {
  const { sheet, settings: s } = g;
  return `
@page { size: Letter ${g.layout === "wide" ? "landscape" : "portrait"}; margin: 0; }
/* Замерочный элемент обязан переносить текст ТОЧНО так же, как .card — иначе подобранный
   кегль не совпадёт с реальной вёрсткой (особенно на длинных словах и ссылках). */
.measurer { position: absolute; left: -99999px; top: 0; visibility: hidden; box-sizing: border-box; font-family: var(--font-lora), Georgia, serif; text-align: center; overflow-wrap: anywhere; }
.toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: #0f172a; color: #fff; z-index: 10; }
.toolbar-title { font: 600 14px system-ui, sans-serif; margin-right: auto; }
.toolbar-btn { font: 600 13px system-ui, sans-serif; padding: 8px 14px; border-radius: 8px; border: 0; background: #22c55e; color: #08260f; cursor: pointer; }
.toolbar-btn.ghost { background: transparent; color: #cbd5e1; border: 1px solid #334155; }
.empty { padding: 40px; text-align: center; color: #64748b; font: 14px system-ui, sans-serif; }
.doc { background: #e2e8f0; }
.sheet {
  width: ${sheet.w}in; height: ${sheet.h}in; margin: 0 auto; background: #fff; box-sizing: border-box;
  /* Безопасное поле — отступом листа, а не @page: тогда экран и печать это одна и та же
     раскладка, и то, что видно в предпросмотре, выйдет из принтера один в один. */
  padding: ${g.safeMarginIn}in;
  page-break-after: always; break-after: page;
  /* Лист — единое целое: карточка не должна уезжать на следующую страницу принтера. */
  page-break-inside: avoid; break-inside: avoid;
}
/* Иначе Chrome выплёвывает лишний пустой лист в конце. */
.sheet:last-child { page-break-after: auto; break-after: auto; }
.grid {
  position: relative; width: 100%; height: 100%;
  display: grid;
  grid-template-columns: ${"1fr ".repeat(sheet.cols).trim()};
  grid-template-rows: ${"1fr ".repeat(sheet.rows).trim()};
}
/* Линии реза — абсолютные, поверх сетки: они не занимают ячейку и не сдвигают ни одну
   карточку, поэтому все карточки остаются строго одного размера. Вертикальной в портретной
   раскладке нет: там столбец один, и резать по середине нечего. */
.cut-v { position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px dashed ${CUT_LINE_COLOR}; }
.cut-h { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed ${CUT_LINE_COLOR}; }
.card {
  box-sizing: border-box; padding: ${g.padY}px ${g.padX}px; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  page-break-inside: avoid; break-inside: avoid;
  /* Длинное слово или ссылка переносятся, а не вылезают за поле. */
  overflow-wrap: anywhere;
  font-family: var(--font-lora), Georgia, serif; color: #111;
}
/* Блок получателя приподнят над серединой карточки. Содержимое центрируется, поэтому поле
   снизу работает вполовину — механика в geometry(). */
.card.recipient { padding-bottom: ${g.recipientPadBottom}px; }
.rec-name { font-size: ${s.recipientPt}pt; font-weight: 400; line-height: 1.3; }
.rec-phone { font-size: ${s.recipientPt}pt; margin-top: 4px; }
.rec-addr { font-size: ${s.recipientPt}pt; margin-top: 4px; line-height: 1.3; }
/* Текст открытки — крупно, по центру, с сохранением переносов */
.msg { white-space: pre-wrap; line-height: ${g.lineHeight}; max-width: 100%; }
/* На ЭКРАНЕ лист ужимается под ширину окна: он задан в дюймах, и альбомные 11in (1056px)
   в окно уже не влезали — браузер обрезал правый край без всякой прокрутки. Масштаб
   считает PrintDocument и кладёт в --fit; zoom, а не transform, потому что transform не
   сжимает место под элементом и между листами оставались бы пустые провалы.
   Печати это не касается: правило внутри @media screen. */
@media screen {
  .doc { zoom: var(--fit, 1); }
  .sheet { box-shadow: 0 1px 6px rgba(0,0,0,.15); margin: 16px auto; }
}
@media print { .no-print { display: none !important; } .doc { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
`;
}
