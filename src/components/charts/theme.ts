/**
 * Общий язык всех графиков Floremart. Обычный модуль без "use client": значения нужны и
 * серверным страницам (подписи метрик), и клиентским компонентам.
 *
 * Смысл файла — чтобы второй график не пришлось «подгонять на глаз» под первый. Цвета,
 * сетка, отступы и формат подписей задаются здесь один раз; сам график только рисует.
 *
 * Визуальный ориентир — Tremor: тонкая горизонтальная сетка без вертикальных линий, оси без
 * своих линий и засечек, скруглённые сверху столбцы, приглушённый slate у подписей и один
 * акцентный цвет на серию. Разноцветье здесь ничего не объясняет: серия всё равно одна.
 */
import { formatCents } from "@/lib/cents";

/** Акцент интерфейса — тот же emerald, что у активных строк и положительных сумм. */
export const CHART_ACCENT = "#059669"; // emerald-600
export const CHART_ACCENT_SOFT = "#10b981"; // emerald-500 — заливка area
export const CHART_GRID = "#e2e8f0"; // slate-200
export const CHART_LABEL = "#94a3b8"; // slate-400
export const CHART_CURSOR = "rgba(100, 116, 139, 0.08)"; // подсветка столбца под курсором

/** Высота области графика. Ниже — столбцы «слипаются», выше — таблица уходит за экран. */
export const CHART_HEIGHT = 340;

/**
 * Как показывать значение. Деньги хранятся целыми центами, поэтому форматирование —
 * обязанность графика, а не вызывающего кода: функцию из серверного компонента не передать.
 */
export type ChartFormat = "money" | "number";

/**
 * Строка данных графика. Индексная сигнатура нужна Recharts: он ищет поле по строковому
 * ключу, и без неё типы осей не сходятся. Доменные типы вроде SiteRevenueRow подходят сюда
 * как есть — ничего преобразовывать не надо.
 */
export type ChartRow = Record<string, string | number>;

/** Что именно рисуем. Одна метрика за раз — иначе график превращается в кашу. */
export type ChartMetric = {
  /** Ключ поля в строке данных. */
  key: string;
  label: string;
  format: ChartFormat;
};

/** Полное значение — для тултипа. */
export function formatChartValue(value: number, format: ChartFormat): string {
  return format === "money" ? formatCents(value) : new Intl.NumberFormat("ru-RU").format(value);
}

/**
 * Короткое значение — для оси Y, где места мало: «$5.4K» вместо «$5,420.00».
 * Точная цифра всегда доступна в тултипе и в таблице под графиком.
 */
export function formatAxisValue(value: number, format: ChartFormat): string {
  if (format === "number") return new Intl.NumberFormat("ru-RU").format(value);
  const dollars = value / 100;
  const abs = Math.abs(dollars);
  if (abs >= 1000) return `$${(dollars / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
  return `$${Math.round(dollars)}`;
}

/** Общие пропсы осей: без своих линий и засечек — их роль играет сетка. */
export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fill: CHART_LABEL, fontSize: 12 },
} as const;

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/**
 * Подпись дня на оси: «2026-08-06» → «6 авг». Дата читается как КАЛЕНДАРНАЯ, в UTC —
 * та же конвенция, что у Order.deliveryDate. Пропустить её через местную таймзону значило бы
 * сдвинуть все подписи на сутки.
 */
export function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}
