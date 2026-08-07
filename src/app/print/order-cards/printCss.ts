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

/**
 * Раскладок две, и выбирает её НАСТРОЙКА ФЛОРИСТА (`financeVisibility`):
 *
 *  - `wide` — альбомный лист, 4 карточки сеткой 2×2. Экономит бумагу вдвое.
 *  - `tall` — портретный лист, 2 карточки одна над другой: получатель сверху, текст снизу.
 *    Карточка вчетверо крупнее, и записка получается «на полстраницы».
 *
 * Печатает только флорист и только свои заказы, поэтому в одном документе всегда одна
 * раскладка — двух ориентаций листа на один принтер не отправить.
 */
export type PrintLayout = "wide" | "tall";

/**
 * Всё, чем отличаются раскладки: размер листа, сетка, поля карточки и диапазон кегля.
 * Одна таблица вместо россыпи констант — иначе половину значений однажды поправят, а
 * половину забудут.
 *
 * У портретной карточки поля по бокам заметно шире: она вчетверо крупнее, и текст во всю
 * ширину семидюймового листа читается как объявление, а не как записка. 120px с каждой
 * стороны дают колонку ровно 480px — на такой ширине строка не «разъезжается» глазами.
 *
 * Кегль там же ниже: потолок 14pt вместо 16 и пол 8pt вместо 10. Низкий пол важнее, чем
 * кажется — именно он решает, поместится длинная записка целиком или уедет продолжением на
 * второй лист. Мельче, но одним куском, лучше, чем крупно и разорванно.
 */
export const SHEET_IN = {
  wide: { w: 11, h: 8.5, cols: 2, rows: 2, padX: 44, padY: 44, basePt: 16, minPt: 10, recipientLiftPx: 0 },
  tall: { w: 8.5, h: 11, cols: 1, rows: 2, padX: 120, padY: 44, basePt: 14, minPt: 8, recipientLiftPx: 80 },
} as const;

/**
 * Насколько поднять блок получателя на портретной карточке.
 *
 * Содержимое карточки центрируется по вертикали, поэтому лишнее поле СНИЗУ сдвигает его
 * вверх ровно на половину: чтобы поднять на 80px, снизу добавляется 160px. Отсюда и
 * умножение — «поднять на N» и «добавить снизу N» это не одно и то же.
 */
const recipientPadBottom = (layout: PrintLayout): number =>
  SHEET_IN[layout].padY + 2 * SHEET_IN[layout].recipientLiftPx;

/** Размер карточки в px при 96 dpi — лист минус поля, поделённый на сетку. */
export function cellSize(layout: PrintLayout): { w: number; h: number } {
  const s = SHEET_IN[layout];
  return {
    w: ((s.w - 2 * SAFE_MARGIN_IN) / s.cols) * PX,
    h: ((s.h - 2 * SAFE_MARGIN_IN) / s.rows) * PX,
  };
}

/** Ширина листа в px при 96 dpi — по ней считается экранный масштаб. */
export const sheetWidthPx = (layout: PrintLayout): number => SHEET_IN[layout].w * PX;

/**
 * Область под текст записки: карточка минус поля. Двенадцать пикселей запаса снизу — чтобы
 * последняя строка не липла к краю обрезки.
 */
export function textArea(layout: PrintLayout): { width: number; height: number } {
  const s = SHEET_IN[layout];
  const cell = cellSize(layout);
  return { width: cell.w - 2 * s.padX, height: cell.h - 2 * s.padY - 12 };
}

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
 * Печатный CSS записок. US Letter (НЕ A4), ориентация и сетка — по раскладке.
 *
 * Заказ занимает СТОЛБЕЦ: сверху получатель, снизу текст открытки. В альбомной раскладке
 * столбцов два, и вертикальный рез посередине отделяет заказы друг от друга; в портретной
 * столбец один — лист и есть заказ, как было до перехода на 2×2.
 */
export function printCss(layout: PrintLayout): string {
  const sheet = SHEET_IN[layout];
  return `
@page { size: Letter ${layout === "wide" ? "landscape" : "portrait"}; margin: 0; }
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
  box-sizing: border-box; padding: ${sheet.padY}px ${sheet.padX}px; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  page-break-inside: avoid; break-inside: avoid;
  /* Длинное слово или ссылка переносятся, а не вылезают за поле. */
  overflow-wrap: anywhere;
  font-family: var(--font-lora), Georgia, serif; color: #111;
}
/* Блок получателя приподнят: на портретной карточке он висел ровно посередине большого
   листа и смотрелся потерянным. Механика — в recipientPadBottom. */
.card.recipient { padding-bottom: ${recipientPadBottom(layout)}px; }
/* Получатель — по центру, ФИО обычного размера (как основной текст) */
.rec-name { font-size: 12pt; font-weight: 400; line-height: 1.3; }
.rec-phone { font-size: 12pt; margin-top: 4px; }
.rec-addr { font-size: 12pt; margin-top: 4px; line-height: 1.3; }
/* Текст открытки — крупно, по центру, с сохранением переносов */
.msg { white-space: pre-wrap; line-height: ${MSG_LINE_HEIGHT}; max-width: 100%; }
/* На ЭКРАНЕ лист ужимается под ширину окна: он задан в дюймах, и альбомные 11" (1056px)
   в окно уже этого просто не влезали — браузер обрезал правый край без всякой прокрутки.
   Масштаб считает PrintDocument и кладёт в --fit; zoom, а не transform, потому что transform
   не сжимает место под элементом и между листами оставались бы пустые провалы.
   Печати это не касается: правило внутри @media screen. */
@media screen {
  .doc { zoom: var(--fit, 1); }
  .sheet { box-shadow: 0 1px 6px rgba(0,0,0,.15); margin: 16px auto; }
}
@media print { .no-print { display: none !important; } .doc { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
`;
}
