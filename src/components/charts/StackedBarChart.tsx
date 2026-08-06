"use client";
/**
 * Столбец на день, собранный из сегментов по сущностям (у нас — по магазинам).
 *
 * Отвечает на другой вопрос, чем обычный BarChart: не «кто больше за период», а «как шли
 * дни и из чего складывался каждый». Итог за период показывает таблица под графиком.
 *
 * Все Bar в одном `stackId`, поэтому высота столбца — сумма дня, а высота сегмента —
 * вклад магазина. Цвет закреплён за местом серии в списке (список отсортирован по имени),
 * а не за её величиной: иначе магазин менял бы цвет от месяца к месяцу.
 */
import { useState } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
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
  seriesColor,
  type ChartRow,
} from "./theme";

export type StackedSeries = { key: string; name: string };

export function StackedBarChart({
  data,
  index,
  series,
  /** Полная подпись дня для тултипа: ключ строки → человеческая дата. */
  titleOf,
  subtitleOf,
  totalLabel,
  height = CHART_HEIGHT,
}: {
  data: ChartRow[];
  index: string;
  series: StackedSeries[];
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

  const colored = series.map((s, i) => ({ ...s, color: seriesColor(i) }));
  const visible = colored.filter((s) => !hidden.has(s.key));

  // Строку под курсором ищем по подписи: тултипу нужны поля, которых нет в payload Recharts.
  const rowByIndex = new Map(data.map((r) => [String(r[index]), r]));

  return (
    <div className="space-y-3">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} strokeDasharray="3 3" />
            {/* interval не задаём: Recharts сам прореживает подписи, когда дней в месяце
                больше, чем помещается на ширину. */}
            <XAxis dataKey={index} {...AXIS_PROPS} minTickGap={8} />
            <YAxis {...AXIS_PROPS} width={64} tickFormatter={(v) => formatAxisValue(Number(v), "money")} />
            <Tooltip
              cursor={{ fill: CHART_CURSOR }}
              isAnimationActive={false}
              // Передаём только active и payload: остальные пропсы Recharts тянут за собой
              // собственный `content` и ломают вывод типов.
              content={({ active, payload, label }) => {
                const row = rowByIndex.get(String(label ?? ""));
                if (!row) return null;
                return (
                  <StackedChartTooltip
                    active={active}
                    payload={payload}
                    series={visible}
                    title={titleOf(row)}
                    subtitle={subtitleOf?.(row)}
                    totalLabel={totalLabel}
                  />
                );
              }}
            />
            {visible.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="total"
                fill={s.color}
                // Скругляется только верхний сегмент стопки — иначе между сегментами
                // появляются щели, и столбец разваливается на плитки.
                radius={i === visible.length - 1 ? [4, 4, 0, 0] : undefined}
                maxBarSize={48}
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>

      {/* Легенда без рамки и заголовка: это подпись к графику, а не отдельный блок. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {colored.map((s) => {
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
