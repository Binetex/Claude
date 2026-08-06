"use client";
/**
 * Единый тултип всех графиков: карточка с названием и точным значением.
 *
 * Свой, а не встроенный в Recharts, по одной причине — встроенный показывает сырое число
 * («542000»), а у нас деньги в центах. Ни осей, ни позиционирования тут нет: их считает
 * Recharts, мы отвечаем только за содержимое карточки.
 */
import type { TooltipContentProps } from "recharts";
import { formatChartValue, type ChartMetric } from "./theme";

export function ChartTooltip({
  active,
  payload,
  label,
  metric,
}: Partial<TooltipContentProps<number, string>> & { metric: ChartMetric }) {
  const point = payload?.[0];
  if (!active || !point) return null;

  const value = typeof point.value === "number" ? point.value : Number(point.value ?? 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <div className="text-xs text-slate-500">{String(label ?? "")}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-sm font-semibold tabular-nums text-slate-900">
          {formatChartValue(value, metric.format)}
        </span>
        <span className="text-xs text-slate-400">{metric.label}</span>
      </div>
    </div>
  );
}

/**
 * Тултип стопки: весь день сразу. Карточка та же, что у одиночного, — меняется только
 * содержимое, поэтому два графика на соседних страницах остаются одним инструментом.
 *
 * Магазины сортируются по сумме ЭТОГО дня, а не по порядку серий: первым должно стоять то,
 * что в этот день дало больше всего. Нулевые не показываем — они бы забивали список.
 */
export function StackedChartTooltip({
  active,
  payload,
  series,
  title,
  totalLabel,
  subtitle,
}: Partial<TooltipContentProps<number, string>> & {
  series: { key: string; name: string; color: string }[];
  /** Заголовок карточки — полная дата дня. */
  title: string;
  totalLabel: string;
  /** Вторая строка заголовка: сколько заказов. */
  subtitle?: string;
}) {
  if (!active || !payload?.length) return null;

  const valueOf = (key: string) => {
    const hit = payload.find((p) => p.dataKey === key);
    return typeof hit?.value === "number" ? hit.value : 0;
  };

  const parts = series
    .map((s) => ({ ...s, value: valueOf(s.key) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = parts.reduce((a, s) => a + s.value, 0);

  return (
    <div className="min-w-52 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <div className="text-xs text-slate-500">{title}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold tabular-nums text-slate-900">
          {formatChartValue(total, "money")}
        </span>
        <span className="text-xs text-slate-400">{totalLabel}</span>
      </div>
      {subtitle && <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>}

      {parts.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {parts.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-slate-600">{s.name}</span>
              <span className="tabular-nums text-slate-900">{formatChartValue(s.value, "money")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
