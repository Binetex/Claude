"use client";
import { useState, useTransition } from "react";
import { ownerSetConsumableUsage } from "./actions";

/**
 * Ячейка «сколько положили» на пересечении заказа и расходника.
 *
 * Пусто = действует расчёт по составу заказа (он показан бледной подсказкой). Введённое число
 * перебивает расчёт, ноль — значимое значение «правило насчитало, а не положили». Стереть
 * содержимое = вернуть расчёт.
 */
export function UsageCell({
  orderId,
  itemId,
  auto,
  manual,
}: {
  orderId: string;
  itemId: string;
  auto: number;
  manual: number | null;
}) {
  const [value, setValue] = useState(manual === null ? "" : String(manual));
  const [saved, setSaved] = useState<"idle" | "ok" | "error">("idle");
  const [pending, start] = useTransition();

  function commit(next: string) {
    const trimmed = next.trim();
    const quantity = trimmed === "" ? null : Number(trimmed);
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0)) {
      setSaved("error");
      return;
    }
    start(async () => {
      const r = await ownerSetConsumableUsage({ orderId, itemId, quantity });
      setSaved(r.error ? "error" : "ok");
    });
  }

  const isManual = value.trim() !== "";
  return (
    <input
      inputMode="numeric"
      value={value}
      placeholder={auto ? String(auto) : "—"}
      disabled={pending}
      onChange={(e) => { setValue(e.target.value); setSaved("idle"); }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      title={auto ? `Расчёт по заказу: ${auto}` : "Система это не считает — отмечается вручную"}
      className={`w-12 rounded border px-1 py-0.5 text-right text-xs tabular-nums ${
        saved === "error"
          ? "border-red-400 bg-red-50"
          : isManual
            ? "border-slate-400 bg-white font-medium"
            : "border-slate-200 bg-slate-50 text-slate-400"
      }`}
    />
  );
}
