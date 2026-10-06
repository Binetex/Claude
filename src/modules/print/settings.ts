/**
 * Настройки печати записок: значения по умолчанию, границы допустимого и пересчёт
 * геометрии. Чистый модуль — без БД и без server-only, поэтому его же читает клиентский
 * компонент печати.
 *
 * Делится всё на две части, и путать их нельзя:
 *  - ФОРМАТ (`SHEET_FORMAT`) — размер листа, ориентация и сетка. Живёт в коде, не
 *    настраивается: это и есть «альбомная 2×2» против «портретной 1×2».
 *  - ТЮНИНГ (`PrintSettings`) — поля, кегли, интерлиньяж. Живёт в БД, крутится владельцем.
 */

/** CSS-пикселей на дюйм. */
const PX = 96;

export type PrintLayout = "wide" | "tall";

/** Раскладка в БД (`PrintLayoutKind`) и обратно. */
export const layoutToKind = (l: PrintLayout): "WIDE" | "TALL" => (l === "wide" ? "WIDE" : "TALL");
export const kindToLayout = (k: "WIDE" | "TALL"): PrintLayout => (k === "WIDE" ? "wide" : "tall");

/**
 * Формат листа. НЕ настраивается: лист US Letter, а сетка — то, чем раскладки и
 * отличаются друг от друга.
 */
export const SHEET_FORMAT = {
  wide: { w: 11, h: 8.5, cols: 2, rows: 2, title: "Альбомная, 4 карточки (2×2)" },
  tall: { w: 8.5, h: 11, cols: 1, rows: 2, title: "Портретная, 2 карточки" },
} as const;

/** Тюнинг одной раскладки. Все значения целые: см. комментарий у модели в схеме. */
export type PrintSettings = {
  safeMarginMils: number;
  textWidthPx: number;
  textHeightPx: number;
  basePt: number;
  minPt: number;
  baseMaxLines: number;
  crowdedStepPt: number;
  lineHeightPct: number;
  recipientPt: number;
  recipientLiftPx: number;
  messageDropPx: number;
};

/**
 * Значения по умолчанию — ровно те, что печатались до появления настроек. Строки в БД
 * может не быть вовсе: тогда работают эти.
 *
 * Поле для текста задано напрямую, а не через отступ. Раньше отступ и замер расходились на
 * 12px запаса — карточка рисовалась с одним полем, а текст подбирался под другое. Теперь
 * число одно, и оно означает ровно то, что написано.
 */
export const PRINT_DEFAULTS: Record<PrintLayout, PrintSettings> = {
  wide: {
    safeMarginMils: 500,
    textWidthPx: 392,
    textHeightPx: 260,
    basePt: 16,
    minPt: 10,
    baseMaxLines: 4,
    crowdedStepPt: 2,
    lineHeightPct: 140,
    recipientPt: 12,
    recipientLiftPx: 0,
    messageDropPx: 0,
  },
  tall: {
    safeMarginMils: 500,
    textWidthPx: 480,
    textHeightPx: 380,
    basePt: 14,
    minPt: 8,
    baseMaxLines: 4,
    crowdedStepPt: 2,
    lineHeightPct: 140,
    recipientPt: 12,
    recipientLiftPx: 80,
    messageDropPx: 0,
  },
};

/**
 * Границы полей. Нужны не для красоты: поле шире карточки или кегль в 200pt дают не
 * «непривычно», а нечитаемый лист и текст, разорванный на десяток страниц.
 *
 * Верхние границы размеров тут широкие — настоящий потолок у поля для текста свой на
 * каждой раскладке (размер карточки), и его накладывает `clampSettings`.
 */
export const PRINT_LIMITS = {
  safeMarginMils: { min: 0, max: 1000, label: "Поле листа (непечатаемая кромка)", unit: "мил", step: 25 },
  textWidthPx: { min: 100, max: 1100, label: "Ширина поля для текста", unit: "px", step: 10 },
  textHeightPx: { min: 60, max: 1100, label: "Высота поля для текста", unit: "px", step: 10 },
  basePt: { min: 6, max: 48, label: "Максимальный кегль записки", unit: "pt", step: 1 },
  minPt: { min: 5, max: 48, label: "Минимальный кегль записки", unit: "pt", step: 1 },
  baseMaxLines: { min: 1, max: 20, label: "Строк максимальным кеглем", unit: "стр.", step: 1 },
  crowdedStepPt: { min: 0, max: 12, label: "Шаг уменьшения кегля", unit: "pt", step: 1 },
  lineHeightPct: { min: 90, max: 250, label: "Интерлиньяж", unit: "%", step: 5 },
  recipientPt: { min: 6, max: 36, label: "Кегль блока получателя", unit: "pt", step: 1 },
  recipientLiftPx: { min: -300, max: 300, label: "Блок получателя", unit: "px", step: 10 },
  messageDropPx: { min: -300, max: 300, label: "Текст открытки", unit: "px", step: 10 },
} as const satisfies Record<keyof PrintSettings, { min: number; max: number; label: string; unit: string; step: number }>;

export const PRINT_FIELDS = Object.keys(PRINT_LIMITS) as (keyof PrintSettings)[];

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));

/**
 * Сантиметры. Форма показывает и принимает только их (владелец 05.10.2026: «писать сразу см»), а в
 * базе остаются px при 96 dpi и тысячные дюйма — форма лишь переводит туда и обратно.
 */
export const PX_PER_CM = PX / 2.54;
export const cmOfPx = (px: number): number => px / PX_PER_CM;
export const pxOfCm = (cm: number): number => Math.round(cm * PX_PER_CM);
export const cmOfMils = (mils: number): number => (mils / 1000) * 2.54;
export const milsOfCm = (cm: number): number => Math.round((cm / 2.54) * 1000);
/** «4,5» — как пишут сантиметры по-русски. */
export const pxToCm = (px: number): string => cmOfPx(px).toFixed(1).replace(".", ",");

/**
 * Половина высоты блока получателя: имя, телефон и адрес — до пяти строк его кеглем.
 * Столько нужно оставить над серединой блока, чтобы подъём не срезал верхнюю строку краем.
 */
const recipientHalfPx = (pt: number): number => Math.ceil(2.5 * ((pt * PX) / 72) * 1.3) + 6;

/** Размер карточки, px: лист минус безопасное поле, поделённый на сетку. */
export function cellSize(layout: PrintLayout, s: PrintSettings): { w: number; h: number } {
  const f = SHEET_FORMAT[layout];
  const margin = s.safeMarginMils / 1000;
  return {
    w: ((f.w - 2 * margin) / f.cols) * PX,
    h: ((f.h - 2 * margin) / f.rows) * PX,
  };
}

/**
 * Приведение к допустимому. Вызывается и при сохранении, и при чтении: строка в БД могла
 * пережить смену формата или правку мимо формы, и печать не должна от этого ломаться.
 *
 * Порядок важен. Поле листа считается первым, потому что от него зависит размер карточки,
 * а от карточки — потолок поля для текста. Пол кегля не может быть выше потолка: иначе
 * подбор размера остался бы без диапазона.
 */
export function clampSettings(layout: PrintLayout, raw: PrintSettings): PrintSettings {
  const s = { ...raw };
  for (const key of PRINT_FIELDS) {
    const lim = PRINT_LIMITS[key];
    s[key] = clamp(Number(s[key]) || 0, lim.min, lim.max);
  }

  const cell = cellSize(layout, s);
  s.textWidthPx = Math.min(s.textWidthPx, Math.floor(cell.w));
  s.textHeightPx = Math.min(s.textHeightPx, Math.floor(cell.h));

  // Пол не выше потолка. Двигаем именно пол: потолок — то, что владелец видит на коротких
  // записках, и менять его молча значит менять внешний вид всех записок разом.
  s.minPt = Math.min(s.minPt, s.basePt);

  // Блоки двигаются от середины своей половины листа в обе стороны: подъём получателя и сдвиг
  // текста открытки вниз со знаком (владелец 05.10.2026: на бумаге оба стояли не там). За край
  // карточки не уезжает ни один: получателю оставляем место на его пять строк, а место под текст
  // открытки ужимается на двойной сдвиг (geometry), но не меньше минимального поля для текста.
  const liftMax = Math.max(0, Math.floor(cell.h / 2 - recipientHalfPx(s.recipientPt)));
  s.recipientLiftPx = Math.max(-liftMax, Math.min(liftMax, s.recipientLiftPx));
  const dropMax = Math.max(0, Math.floor((cell.h - PRINT_LIMITS.textHeightPx.min) / 2));
  s.messageDropPx = Math.max(-dropMax, Math.min(dropMax, s.messageDropPx));

  return s;
}

/**
 * Где на листе середины блоков — от ВЕРХНЕГО КРАЯ листа, px. Так их меряет владелец линейкой
 * (05.10.2026: «мне проще смотреть отступы от верхней границы»), и от числа строк в блоке это
 * число не зависит. В базе хранится сдвиг от середины своей половины — отсюда пересчёт.
 */
export function blockCenters(layout: PrintLayout, raw: PrintSettings): { recipient: number; message: number } {
  const s = clampSettings(layout, raw);
  const cell = cellSize(layout, s);
  const top = (s.safeMarginMils / 1000) * PX;
  return { recipient: top + cell.h / 2 - s.recipientLiftPx, message: top + cell.h * 1.5 + s.messageDropPx };
}

/**
 * Обратно: середины блоков от верхнего края листа → сдвиги для базы. Что недостижимо (за краем
 * карточки), подрежет clampSettings, и форма покажет, куда блок встал на самом деле.
 */
export function withBlockCenters(layout: PrintLayout, raw: PrintSettings, centers: { recipient?: number; message?: number }): PrintSettings {
  const s = clampSettings(layout, raw);
  const cell = cellSize(layout, s);
  const top = (s.safeMarginMils / 1000) * PX;
  return {
    ...raw,
    ...(centers.recipient != null ? { recipientLiftPx: Math.round(top + cell.h / 2 - centers.recipient) } : {}),
    ...(centers.message != null ? { messageDropPx: Math.round(centers.message - top - cell.h * 1.5) } : {}),
  };
}

/**
 * Всё, что нужно вёрстке: отступы карточки — это карточка минус поле для текста, пополам.
 * Отдельной настройкой отступ быть не может, это то же число с другой стороны.
 */
export type PrintGeometry = {
  layout: PrintLayout;
  settings: PrintSettings;
  sheet: { w: number; h: number; cols: number; rows: number };
  safeMarginIn: number;
  cell: { w: number; h: number };
  padX: number;
  padY: number;
  lineHeight: number;
  /**
   * Высота, в которую подбирается текст открытки. Текст стоит по середине карточки и сдвинут
   * на `messageDropPx` (вниз или вверх), поэтому с одной стороны ему остаётся на сдвиг меньше — а
   * держать его по центру значит отнять столько же и с другой: (карточка − 2 × |сдвиг|), не больше
   * поля. Без сдвига это ровно поле для текста.
   */
  messageHeightPx: number;
};

export function geometry(layout: PrintLayout, raw: PrintSettings): PrintGeometry {
  const s = clampSettings(layout, raw);
  const f = SHEET_FORMAT[layout];
  const cell = cellSize(layout, s);
  const padX = Math.max(0, (cell.w - s.textWidthPx) / 2);
  const padY = Math.max(0, (cell.h - s.textHeightPx) / 2);
  return {
    layout,
    settings: s,
    sheet: { w: f.w, h: f.h, cols: f.cols, rows: f.rows },
    safeMarginIn: s.safeMarginMils / 1000,
    cell,
    padX,
    padY,
    lineHeight: s.lineHeightPct / 100,
    messageHeightPx: Math.min(s.textHeightPx, Math.floor(cell.h - 2 * Math.abs(s.messageDropPx))),
  };
}

/** Ширина листа в px при 96dpi — по ней считается экранный масштаб. */
export const sheetWidthPx = (layout: PrintLayout): number => SHEET_FORMAT[layout].w * PX;
