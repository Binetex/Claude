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
