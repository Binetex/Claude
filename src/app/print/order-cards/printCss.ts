/**
 * Геометрия печатного листа записок. ЕДИНСТВЕННЫЙ источник значений: эти же константы
 * подставляются в CSS ниже и берёт PrintDocument, когда считает область для замера текста.
 * Разъедься замер с вёрсткой — подобранный кегль не совпадёт с реальной, и длинный текст
 * переполнит карточку.
 */

/** CSS-пикселей на дюйм. */
const PX = 96;

/**
 * Безопасное поле листа, дюймы. Бытовые американские принтеры (inkjet и лазерные) физически
 * не печатают у краёв — как правило 0.16–0.25", у части inkjet до 0.5" снизу. Полдюйма со
 * всех сторон перекрывает этот разброс с запасом, поэтому ни одна карточка не обрежется.
 *
 * Поле задано ОТСТУПОМ ЛИСТА, а не `@page margin`: тогда экран и печать — одна и та же
 * раскладка, и то, что видно в предпросмотре, выйдет из принтера один в один.
 */
export const SAFE_MARGIN_IN = 0.5;

/** Лист US Letter АЛЬБОМНО: 11" в ширину, 8.5" в высоту. */
export const SHEET_W_IN = 11;
export const SHEET_H_IN = 8.5;

/** Печатная область: лист минус безопасные поля. */
const CONTENT_W_IN = SHEET_W_IN - 2 * SAFE_MARGIN_IN;
const CONTENT_H_IN = SHEET_H_IN - 2 * SAFE_MARGIN_IN;

/** Карточка — четверть печатной области: сетка 2×2, все четыре одного размера. */
export const CELL_W_PX = (CONTENT_W_IN / 2) * PX; // 480 = 5"
export const CELL_H_PX = (CONTENT_H_IN / 2) * PX; // 360 = 3.75"

/**
 * Внутреннее поле карточки, px. Оно же — расстояние от линии реза до текста, поэтому мелким
 * его брать нельзя: ножницы редко идут точно по линии.
 */
export const CARD_PADDING_PX = 44;

/**
 * Линии реза — вспомогательные, а не часть открытки: их видно ровно настолько, чтобы попасть
 * ножницами. Отсюда 20% непрозрачности вместо сплошного серого.
 */
const CUT_LINE_COLOR = "rgba(100, 116, 139, 0.2)";

/**
 * Межстрочный интервал текста открытки. Отсюда же его берёт подбор кегля, когда считает,
 * сколько строк займёт записка: разойдись эти два числа — правило «с пятой строки мельче»
 * начнёт срабатывать не на той строке.
 */
export const MSG_LINE_HEIGHT = 1.4;

/**
 * Печатный CSS записок. US Letter АЛЬБОМНО (НЕ A4), 4 карточки на листе сеткой 2×2.
 *
 * Заказ занимает СТОЛБЕЦ: сверху получатель, снизу текст открытки — тот же порядок, что был
 * на половинах листа. Один вертикальный рез посередине отделяет заказы друг от друга,
 * горизонтальный — получателя от текста.
 */
export const PRINT_CSS = `
@page { size: Letter landscape; margin: 0; }
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
  width: ${SHEET_W_IN}in; height: ${SHEET_H_IN}in; margin: 0 auto; background: #fff; box-sizing: border-box;
  /* Безопасное поле — здесь, а не в @page: см. SAFE_MARGIN_IN. */
  padding: ${SAFE_MARGIN_IN}in;
  page-break-after: always; break-after: page;
  /* Лист — единое целое: карточка не должна уезжать на следующую страницу принтера. */
  page-break-inside: avoid; break-inside: avoid;
}
/* Иначе Chrome выплёвывает лишний пустой лист в конце. */
.sheet:last-child { page-break-after: auto; break-after: auto; }
.grid {
  position: relative; width: 100%; height: 100%;
  display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
}
/* Линии реза — абсолютные, поверх сетки: они не занимают ячейку и не сдвигают ни одну
   карточку, поэтому все четыре остаются строго одного размера. */
.cut-v { position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px dashed ${CUT_LINE_COLOR}; }
.cut-h { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed ${CUT_LINE_COLOR}; }
.card {
  box-sizing: border-box; padding: ${CARD_PADDING_PX}px; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  page-break-inside: avoid; break-inside: avoid;
  /* Длинное слово или ссылка переносятся, а не вылезают за поле. */
  overflow-wrap: anywhere;
  font-family: var(--font-lora), Georgia, serif; color: #111;
}
/* Получатель — по центру, ФИО обычного размера (как основной текст) */
.rec-name { font-size: 12pt; font-weight: 400; line-height: 1.3; }
.rec-phone { font-size: 12pt; margin-top: 4px; }
.rec-addr { font-size: 12pt; margin-top: 4px; line-height: 1.3; }
/* Текст открытки — крупно, по центру, с сохранением переносов */
.msg { white-space: pre-wrap; line-height: ${MSG_LINE_HEIGHT}; max-width: 100%; }
@media screen { .sheet { box-shadow: 0 1px 6px rgba(0,0,0,.15); margin: 16px auto; } }
@media print { .no-print { display: none !important; } .doc { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
`;
