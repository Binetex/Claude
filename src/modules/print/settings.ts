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
  recipientLiftPx: { min: 0, max: 300, label: "Подъём блока получателя", unit: "px", step: 10 },
} as const satisfies Record<keyof PrintSettings, { min: number; max: number; label: string; unit: string; step: number }>;

export const PRINT_FIELDS = Object.keys(PRINT_LIMITS) as (keyof PrintSettings)[];

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));

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

  // Подъём съедает ВДВОЕ больше места, чем поднимает (поле снизу двойное), поэтому больше
  // четверти поля для текста ему не отдаём: остальное нужно самому блоку получателя.
  s.recipientLiftPx = Math.min(s.recipientLiftPx, Math.floor(s.textHeightPx / 4));

  return s;
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
  /** Поле снизу у блока получателя. Содержимое центрируется, поэтому подъём на N требует
   *  2N снизу: «поднять на N» и «добавить снизу N» — не одно и то же. */
  recipientPadBottom: number;
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
    recipientPadBottom: padY + 2 * s.recipientLiftPx,
  };
}

/** Ширина листа в px при 96dpi — по ней считается экранный масштаб. */
export const sheetWidthPx = (layout: PrintLayout): number => SHEET_FORMAT[layout].w * PX;
