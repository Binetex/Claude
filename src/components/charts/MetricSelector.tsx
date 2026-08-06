"use client";
/**
 * Переключатель показателя над графиком. Один общий на все графики — иначе на второй
 * странице появится «почти такой же», и они разойдутся.
 *
 * Вид намеренно тот же, что у переключателя периода на странице магазинов: это одна и та же
 * по смыслу вещь — выбор из нескольких взаимоисключающих вариантов.
 */
import { cn } from "@/lib/cn";
import type { ChartMetric } from "./theme";

export function MetricSelector({
  metrics,
  current,
  onChange,
}: {
  metrics: ChartMetric[];
  current: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
      {metrics.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onChange(m.key)}
          className={cn(
            "rounded-md px-3 py-1 text-sm font-medium transition-colors",
            current === m.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
