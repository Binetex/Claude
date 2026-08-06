"use client";
/**
 * График динамики: как показатель меняется во времени.
 *
 * Тот же язык, что у столбчатого — сетка, оси, тултип и формат значений берутся из общего
 * theme.ts, поэтому два графика на соседних страницах выглядят как один инструмент, а не
 * как два разных.
 *
 * Заливка под линией мягкая и одноцветная: она показывает объём, а не добавляет ещё одну
 * величину, и спорить с текстом рядом не должна.
 */
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";
import {
  AXIS_PROPS,
  CHART_ACCENT,
  CHART_ACCENT_SOFT,
  CHART_GRID,
  CHART_HEIGHT,
  formatAxisValue,
  type ChartMetric,
  type ChartRow,
} from "./theme";

export function AreaChart({
  data,
  index,
  metric,
  height = CHART_HEIGHT,
}: {
  data: ChartRow[];
  /** Ключ подписи по оси X. */
  index: string;
  metric: ChartMetric;
  height?: number;
}) {
  // Уникальный id градиента: два графика на одной странице иначе делят одну заливку.
  const gradientId = `area-${metric.key}`;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsAreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_ACCENT_SOFT} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_ACCENT_SOFT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} strokeDasharray="3 3" />
          <XAxis dataKey={index} {...AXIS_PROPS} minTickGap={16} />
          <YAxis
            {...AXIS_PROPS}
            width={64}
            // Штуки целые: «1,5 заказа» на оси — бессмыслица. У денег дробные шаги уместны.
            allowDecimals={metric.format !== "number"}
            tickFormatter={(v) => formatAxisValue(Number(v), metric.format)}
          />
          <Tooltip
            cursor={{ stroke: CHART_GRID }}
            content={<ChartTooltip metric={metric} />}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey={metric.key}
            stroke={CHART_ACCENT}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            // Точка на каждом дне превращает месяц в бусы; при наведении она всё равно есть.
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: CHART_ACCENT }}
          />
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
