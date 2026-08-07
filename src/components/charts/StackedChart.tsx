"use client";
/**
 * День, собранный из сегментов по сущностям: магазинам, флористам — кому угодно.
 *
 * Отвечает не на вопрос «кто больше за период» (на него отвечает таблица под графиком), а
 * «как шли дни и из чего складывался каждый». Все серии в одном `stackId`, поэтому верхняя
 * граница — сумма дня, а сегмент — вклад одной сущности.
 *
 * Рисоваться это может столбцами или областями (`kind`) — разница чисто визуальная, и
 * держать под неё два компонента незачем: оси, сетка, тултип и легенда у них одни и те же.
 * Столбцы лучше читаются на коротком периоде, области — на длинном, где столбцы вырождаются
 * в частокол.
 *
 * Области именно СЛОЖЕНЫ, а не наложены: наложенные полупрозрачные заливки смешиваются в
 * цвета, которых нет в легенде, и по ним нельзя прочитать ни одну серию.
 *
 * Цвет НЕ вычисляется здесь: он приходит вместе с серией. Считать его по месту в массиве
 * было ошибкой — сущность без данных за период из массива выпадает и перекрашивает всех
 * следующих, из-за чего цвета «скачут» при смене дат.
 */
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/cn";
import { StackedChartTooltip } from "./ChartTooltip";
import {
  AXIS_PROPS,
  CHART_CURSOR,
  CHART_GRID,
  CHART_HEIGHT,
  formatAxisValue,
  type ChartRow,
} from "./theme";

/** Цвет задаёт вызывающий код: он закреплён за сущностью, а не за местом в серии. */
export type StackedSeries = { key: string; name: string; color: string };

export function StackedChart({
  data,
  index,
  series,
  kind = "bar",
  /** Полная подпись дня для тултипа: строка данных → человеческая дата. */
  titleOf,
  subtitleOf,
  totalLabel,
  height = CHART_HEIGHT,
}: {
  data: ChartRow[];
  index: string;
  series: StackedSeries[];
  kind?: "bar" | "area";
  titleOf: (row: ChartRow) => string;
  subtitleOf?: (row: ChartRow) => string;
  totalLabel: string;
  height?: number;
}) {
  // Скрытые серии живут в состоянии, а не в адресе: это разглядывание графика, а не выбор,
  // который стоит сохранять и пересылать.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const visible = series.filter((s) => !hidden.has(s.key));
  const area = kind === "area";
  const Chart = area ? AreaChart : BarChart;

  const tooltip = (
    <Tooltip
      cursor={area ? { stroke: CHART_GRID } : { fill: CHART_CURSOR }}
      isAnimationActive={false}
      // Строка целиком лежит в payload первой серии: тултипу нужны поля (дата, заказы),
      // которых в самом payload нет.
      content={({ active, payload, label }) => {
        const row = payload?.[0]?.payload as ChartRow | undefined;
        if (!row) return null;
        return (
          <StackedChartTooltip
            active={active}
            payload={payload}
            label={label}
            series={visible}
            title={titleOf(row)}
            subtitle={subtitleOf?.(row)}
            totalLabel={totalLabel}
          />
        );
      }}
    />
  );

  return (
    <div className="space-y-3">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {area && (
              <defs>
                {visible.map((s) => (
                  // id завязан на ключ серии: иначе два графика на странице делят заливку.
                  <linearGradient key={s.key} id={`stacked-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.04} />
                  </linearGradient>
                ))}
              </defs>
            )}
            <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} strokeDasharray="3 3" />
            {/* interval не задаём: Recharts сам прореживает подписи, когда дней в месяце
                больше, чем помещается на ширину. */}
            <XAxis dataKey={index} {...AXIS_PROPS} minTickGap={8} />
            <YAxis {...AXIS_PROPS} width={64} tickFormatter={(v) => formatAxisValue(Number(v), "money")} />
            {tooltip}
            {visible.map((s) =>
              area ? (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stackId="total"
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#stacked-${s.key})`}
                  // Точка на каждом дне превращает месяц в бусы; при наведении она есть.
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0, fill: s.color }}
                  isAnimationActive={false}
                />
              ) : (
                // Углы прямые: на стопке скругление режет верхний сегмент и оставляет щели
                // между соседними.
                <Bar key={s.key} dataKey={s.key} stackId="total" fill={s.color} maxBarSize={48} />
              )
            )}
          </Chart>
        </ResponsiveContainer>
      </div>

      {/* Легенда без рамки и заголовка: это подпись к графику, а не отдельный блок. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => {
          const off = hidden.has(s.key);
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => toggle(s.key)}
                aria-pressed={!off}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-opacity",
                  off ? "opacity-40" : "hover:opacity-70"
                )}
              >
                <span
                  className="size-2.5 rounded-[3px]"
                  style={{ background: off ? "#cbd5e1" : s.color }}
                />
                <span className={cn("text-slate-600", off && "line-through")}>{s.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
