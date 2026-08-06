"use client";
/**
 * График сравнения магазинов. Переключатель показателя живёт здесь, потому что это
 * единственное состояние экрана: всё остальное приходит с сервера и меняется вместе с
 * периодом.
 *
 * `rows` — ТОТ ЖЕ массив, что уходит в таблицу под графиком, без преобразований. Отдельного
 * запроса ради картинки нет и быть не должно: тогда график и таблица однажды разойдутся.
 */
import { useState } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { MetricSelector } from "@/components/charts/MetricSelector";
import type { ChartMetric } from "@/components/charts/theme";
import type { SiteRevenueRow } from "@/modules/finance/sitesRevenue";

/** Ключи совпадают с полями SiteRevenueRow — график читает строку напрямую. */
const METRICS: ChartMetric[] = [
  { key: "revenueCents", label: "Выручка", format: "money" },
  { key: "ordersTotal", label: "Заказы", format: "number" },
  { key: "avgCents", label: "Средний чек", format: "money" },
];

export function SitesChart({ rows, hrefQuery }: { rows: SiteRevenueRow[]; hrefQuery?: string }) {
  const [key, setKey] = useState(METRICS[0].key);
  const metric = METRICS.find((m) => m.key === key) ?? METRICS[0];

  return (
    <div className="space-y-3">
      <MetricSelector metrics={METRICS} current={metric.key} onChange={setKey} />
      <BarChart
        data={rows}
        index="name"
        metric={metric}
        hrefKey="siteId"
        hrefBase="/dashboard/finance/sites"
        hrefQuery={hrefQuery}
      />
    </div>
  );
}
