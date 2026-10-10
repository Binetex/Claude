"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerSetFloristBouquetShare } from "./floristActions";

/** Доли по 5%: 40…80. Значение вне сетки (заданное раньше) показывается отдельной строкой. */
const OPTIONS = Array.from({ length: 9 }, (_, i) => 40 + i * 5);

/**
 * Сколько флорист получает за букет: цену из каталога, как все, или долю от цены букета на сайте.
 * Добавки (вазы, подарки, открытки) при доле всё равно идут по цене каталога. Сохраняется сразу и
 * действует на заказы, назначенные после изменения.
 */
export function BouquetShareEditor({ floristId, sharePercentBp }: { floristId: string; sharePercentBp: number | null }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState<number | null>(sharePercentBp == null ? null : sharePercentBp / 100);

  function change(raw: string) {
    const next = raw === "" ? null : Number(raw);
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await ownerSetFloristBouquetShare(floristId, next);
      if (res.error) {
        setValue(prev);
        toast.error(res.error);
      }
    });
  }

  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>За букет</span>
      <select
        value={value ?? ""}
        onChange={(e) => change(e.target.value)}
        disabled={pending}
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-slate-800 disabled:opacity-50"
      >
        <option value="">цена из каталога</option>
        {value != null && !OPTIONS.includes(value) && <option value={value}>{value}% от цены на сайте</option>}
        {OPTIONS.map((p) => (
          <option key={p} value={p}>
            {p}% от цены на сайте
          </option>
        ))}
      </select>
      <span className="text-xs text-slate-400">добавки — по цене каталога; для заказов, назначенных после изменения</span>
    </label>
  );
}
