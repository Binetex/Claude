"use client";
import { useState, useTransition } from "react";

/**
 * Инлайн-редактор цены флориста (для товара или варианта). Сохраняет по blur/Enter.
 * `allowEmpty` — можно очистить (для варианта: null → действует цена товара).
 */
export function InlinePrice({
  initial,
  onSave,
  allowEmpty = false,
  placeholder = "—",
}: {
  initial: number | null;
  onSave: (amount: number | null) => Promise<void>;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial != null ? String(initial) : "");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    const raw = value.trim();
    if (raw === "") {
      if (!allowEmpty) return; // очистка запрещена — оставляем как есть
      start(async () => {
        await onSave(null);
        flash();
      });
      return;
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return;
    start(async () => {
      await onSave(amount);
      flash();
    });
  }

  function flash() {
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        disabled={pending}
        placeholder={placeholder}
        className="w-20 rounded-md border border-slate-200 px-2 py-1 text-right text-sm focus:border-slate-400 disabled:opacity-60"
      />
      {saved && <span className="text-xs text-emerald-600">✓</span>}
    </div>
  );
}
