"use client";
/**
 * Динамика нескольких величин по дням: у каждой серии своя область, сложенные в стопку.
 *
 * Визуальный ориентир — Tremor Area Chart: мягкая градиентная заливка, тонкая
 * горизонтальная сетка без вертикальных линий, оси без своих линий и засечек, спокойная
 * легенда сверху. Тултип и палитра — общие для всех графиков Floremart (theme.ts), поэтому
 * соседние страницы выглядят одним инструментом.
 *
 * Области СЛОЖЕНЫ, а не наложены друг на друга. Наложенные полупрозрачные заливки
 * смешиваются в цвета, которых нет в легенде, и по ним нельзя прочитать ни одну серию.
 * У стопки же верхняя граница — это сумма дня, поэтому одна картинка отвечает сразу на два
 * вопроса: сколько дал каждый и сколько вышло всего.
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
import { StackedChartTooltip } from "./ChartTooltip";
import {
  AXIS_PROPS,
  CHART_GRID,
  CHART_HEIGHT,
  formatAxisValue,
  type ChartRow,
} from "./theme";

export type AreaSeries = { key: string; name: string; color: string };

export function MultiAreaChart({
  data,
  index,
  series,
  titleOf,
  subtitleOf,
  totalLabel,
  height = CHART_HEIGHT,
}: {
  data: ChartRow[];
  /** Ключ подписи по оси X. */
  index: string;
  series: AreaSeries[];
  /** Заголовок тултипа по строке данных — обычно полная дата. */
  titleOf: (row: ChartRow) => string;
  subtitleOf?: (row: ChartRow) => string;
  totalLabel: string;
  height?: number;
}) {
  return (
    <div className="w-full">
      <Legend series={series} />
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsAreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {series.map((s) => (
                // id завязан на ключ серии: иначе два графика на странице делят одну заливку.
                <linearGradient key={s.key} id={`area-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.04} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} strokeDasharray="3 3" />
            <XAxis dataKey={index} {...AXIS_PROPS} minTickGap={16} />
            <YAxis
              {...AXIS_PROPS}
              width={64}
              tickFormatter={(v) => formatAxisValue(Number(v), "money")}
            />
            <Tooltip
              cursor={{ stroke: CHART_GRID }}
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                // Строка целиком нужна тултипу ради даты и числа заказов: в payload лежат
                // только значения серий.
                const row = (payload?.[0]?.payload ?? {}) as ChartRow;
                return (
                  <StackedChartTooltip
                    active={active}
                    payload={payload}
                    label={label}
                    series={series}
                    title={titleOf(row)}
                    subtitle={subtitleOf?.(row)}
                    totalLabel={totalLabel}
                  />
                );
              }}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stackId="earnings"
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#area-${s.key})`}
                // Точка на каждом дне превращает месяц в бусы; при наведении она всё равно есть.
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: s.color }}
                isAnimationActive={false}
              />
            ))}
          </RechartsAreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Легенда сверху. Своя, а не рекчартовская: встроенная тянет свои отступы и шрифт и живёт
 * внутри области графика, отбирая у него высоту.
 */
function Legend({ series }: { series: AreaSeries[] }) {
  if (series.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
