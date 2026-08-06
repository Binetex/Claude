"use client";
/**
 * Динамика магазина по дням. Тот же массив, что уходит в список дней под графиком.
 *
 * Два преобразования, оба про показ, а не про данные: порядок разворачивается (список идёт
 * от новых к старым, а время на графике течёт слева направо) и дата превращается в короткую
 * подпись оси.
 */
import { useMemo, useState } from "react";
import { AreaChart } from "@/components/charts/AreaChart";
import { MetricSelector } from "@/components/charts/MetricSelector";
import { formatDayLabel, type ChartMetric } from "@/components/charts/theme";
import type { SiteDay } from "@/modules/finance/sitesRevenue";

const METRICS: ChartMetric[] = [
  { key: "revenueCents", label: "Выручка", format: "money" },
  { key: "ordersTotal", label: "Заказы", format: "number" },
];

export function SiteDaysChart({ days }: { days: SiteDay[] }) {
  const [key, setKey] = useState(METRICS[0].key);
  const metric = METRICS.find((m) => m.key === key) ?? METRICS[0];

  const points = useMemo(
    () =>
      [...days]
        .reverse()
        .map((d) => ({ label: formatDayLabel(d.day), revenueCents: d.revenueCents, ordersTotal: d.ordersTotal })),
    [days]
  );

  return (
    <div className="space-y-3">
      <MetricSelector metrics={METRICS} current={metric.key} onChange={setKey} />
      <AreaChart data={points} index="label" metric={metric} />
    </div>
  );
}
