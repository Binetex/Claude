"use client";
/**
 * Динамика выручки магазинов по дням выбранного периода.
 *
 * Отвечает на другой вопрос, чем таблица под ним: таблица говорит «сколько всего за
 * период», график — «как шли дни и из чего складывался каждый». Повторять итоги ещё и
 * картинкой смысла нет, поэтому рейтинга магазинов здесь больше не рисуем.
 *
 * `points` и `rows` приходят из ОДНОГО серверного результата (`getSitesRevenue`): там одна
 * группировка «день × магазин», а итоги таблицы — сумма тех же дней. Разойтись им нечем.
 *
 * Переключателя показателя тут нет намеренно: складывать в стопку средний чек нельзя (это
 * среднее, а не величина), а «заказы» отдельным графиком никто не просил.
 */
import { StackedBarChart } from "@/components/charts/StackedBarChart";
import { fullDayLabel } from "@/modules/finance/period";
import { pluralOrders } from "@/modules/finance/earningsFormat";
import type { SiteDailyPoint, SiteSeries } from "@/modules/finance/sitesRevenue";

export function SitesChart({ points, series }: { points: SiteDailyPoint[]; series: SiteSeries[] }) {
  return (
    <StackedBarChart
      data={points}
      index="label"
      series={series.map((s) => ({ key: s.siteId, name: s.name, color: s.color }))}
      titleOf={(row) => fullDayLabel(String(row.day))}
      subtitleOf={(row) => pluralOrders(Number(row.orders) || 0)}
      totalLabel="за день"
    />
  );
}
