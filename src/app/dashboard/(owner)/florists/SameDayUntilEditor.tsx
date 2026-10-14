"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerSetFloristSameDayUntil } from "./floristActions";

/** Варианты отсечки: 10:00…17:00 по получасу. */
const OPTIONS = Array.from({ length: 15 }, (_, i) => 10 * 60 + i * 30);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/**
 * До какого часа флорист получает заказы НА СЕГОДНЯ (владелец 14.10.2026: Арине — до 13:00). Позже
 * автоназначение отдаёт заказ на сегодня следующему в очереди магазина. Заказы на другие дни не
 * затрагивает. Сохраняется сразу.
 */
export function SameDayUntilEditor({ floristId, sameDayUntilMin }: { floristId: string; sameDayUntilMin: number | null }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState<number | null>(sameDayUntilMin);

  function change(raw: string) {
    const next = raw === "" ? null : Number(raw);
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await ownerSetFloristSameDayUntil(floristId, next);
      if (res.error) {
        setValue(prev);
        toast.error(res.error);
      }
    });
  }

  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>Заказы на сегодня</span>
      <select
        value={value ?? ""}
        onChange={(e) => change(e.target.value)}
        disabled={pending}
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-slate-800 disabled:opacity-50"
      >
        <option value="">в любое время</option>
        {value != null && !OPTIONS.includes(value) && <option value={value}>только до {hm(value)}</option>}
        {OPTIONS.map((m) => (
          <option key={m} value={m}>
            только до {hm(m)}
          </option>
        ))}
      </select>
      <span className="text-xs text-slate-400">позже заказ на сегодня уходит следующему в очереди магазина</span>
    </label>
  );
}
