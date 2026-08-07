"use client";
/**
 * Динамика заработка флористов по дням выбранного периода.
 *
 * Отвечает не на тот вопрос, что таблица под ним: таблица говорит «сколько всего и сколько
 * должны», график — «как шли дни и кто в какой день работал». Повторять итоги ещё и
 * картинкой смысла нет.
 *
 * `points` и `series` приходят из ОДНОГО серверного результата (`getFloristsEarnings`):
 * итоги сверху — сумма тех же дней, поэтому разойтись им нечем.
 */
import { StackedChart } from "@/components/charts/StackedChart";
import { fullDayLabel } from "@/modules/finance/period";
import { pluralOrders } from "@/modules/finance/earningsFormat";
import type { FloristDailyPoint, FloristSeries } from "@/modules/finance/floristsEarnings";

export function FloristsChart({ points, series }: { points: FloristDailyPoint[]; series: FloristSeries[] }) {
  return (
    <StackedChart
      kind="area"
      data={points}
      index="label"
      series={series.map((s) => ({ key: s.floristId, name: s.name, color: s.color }))}
      titleOf={(row) => fullDayLabel(String(row.day))}
      subtitleOf={(row) => pluralOrders(Number(row.orders) || 0)}
      totalLabel="за день"
    />
  );
}
