"use client";
/**
 * Столбчатый график: сравнение сущностей по одному показателю.
 *
 * Работает на Recharts — оси, шкалы, попадание курсора и адаптив считает он. Своей
 * математики здесь нет намеренно: самописные оси ломаются на первом же отрицательном
 * значении или длинной подписи.
 *
 * Данные принимаются КАК ЕСТЬ, тем же массивом, что уходит в таблицу под графиком: ключ
 * подписи и ключ значения задаются пропсами. Так график и таблица физически не могут
 * разойтись, а второй запрос ради картинки не появляется.
 *
 * Ссылка для клика собирается из поля строки (`hrefKey`), а не из колбэка: страница
 * серверная, и функцию в неё не передать.
 */
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart as RechartsBarChart,
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
  CHART_CURSOR,
  CHART_GRID,
  CHART_HEIGHT,
  formatAxisValue,
  type ChartMetric,
  type ChartRow,
} from "./theme";

/** Длинные названия магазинов режем: подпись под столбцом должна быть в одну строку. */
const shortLabel = (v: unknown) => {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 11)}…` : s;
};

export function BarChart({
  data,
  index,
  metric,
  hrefKey,
  hrefBase,
  hrefQuery,
  height = CHART_HEIGHT,
}: {
  data: ChartRow[];
  /** Ключ подписи по оси X. */
  index: string;
  metric: ChartMetric;
  /** Ключ поля со значением для ссылки (например siteId). Без него столбцы некликабельны. */
  hrefKey?: string;
  hrefBase?: string;
  hrefQuery?: string;
  height?: number;
}) {
  const router = useRouter();
  const clickable = !!(hrefKey && hrefBase);

  const open = (row: ChartRow | undefined) => {
    if (!clickable || !row) return;
    const id = row[hrefKey];
    if (!id) return;
    router.push(`${hrefBase}/${String(id)}${hrefQuery ? `?${hrefQuery}` : ""}`);
  };

  return (
    // Ширина ограничена контейнером, поэтому на телефоне график сжимается, а не выталкивает
    // страницу за экран.
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {/* Только горизонтальные линии: вертикальные ничего не добавляют, а рябят. */}
          <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} strokeDasharray="3 3" />
          <XAxis dataKey={index} {...AXIS_PROPS} interval={0} tickFormatter={shortLabel} />
          <YAxis
            {...AXIS_PROPS}
            width={64}
            // Штуки целые: «1,5 заказа» на оси — бессмыслица. У денег дробные шаги уместны.
            allowDecimals={metric.format !== "number"}
            tickFormatter={(v) => formatAxisValue(Number(v), metric.format)}
          />
          <Tooltip
            cursor={{ fill: CHART_CURSOR }}
            content={<ChartTooltip metric={metric} />}
            // Иначе тултип «плывёт» за курсором внутри столбца и дёргается.
            isAnimationActive={false}
          />
          <Bar
            dataKey={metric.key}
            fill={CHART_ACCENT}
            radius={[6, 6, 0, 0]}
            maxBarSize={72}
            cursor={clickable ? "pointer" : undefined}
            onClick={(_, i) => open(data[i])}
          />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
