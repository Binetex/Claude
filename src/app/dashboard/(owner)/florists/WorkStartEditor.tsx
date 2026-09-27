"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerSetFloristWorkStart } from "./floristActions";

/** Варианты начала работы: 6:00…14:00 по получасу. */
const OPTIONS = Array.from({ length: 17 }, (_, i) => 6 * 60 + i * 30);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/**
 * Во сколько флорист начинает собирать букеты. От этого часа считается его расписание на день —
 * «График доставки» и самое раннее время, которое ассистент называет клиентам. Сохраняется сразу.
 */
export function WorkStartEditor({ floristId, workStartMin }: { floristId: string; workStartMin: number | null }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState<number | null>(workStartMin);

  function change(next: number) {
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await ownerSetFloristWorkStart(floristId, next);
      if (res.error) {
        setValue(prev);
        toast.error(res.error);
      }
    });
  }

  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>Начинает работу в</span>
      <select
        value={value ?? ""}
        onChange={(e) => change(Number(e.target.value))}
        disabled={pending}
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-slate-800 disabled:opacity-50"
      >
        {value == null && <option value="">не задано (10:00)</option>}
        {OPTIONS.map((m) => (
          <option key={m} value={m}>
            {hm(m)}
          </option>
        ))}
      </select>
      <span className="text-xs text-slate-400">от этого часа считается график доставки</span>
    </label>
  );
}
