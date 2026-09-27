"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import { ownerSetFloristMorningCapacity } from "./floristActions";

/** Лимит утра флориста: ± по одному, сохраняется сразу. */
export function MorningCapacityEditor({ floristId, capacity }: { floristId: string; capacity: number }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(capacity);

  function change(next: number) {
    if (next < 0 || next > 20) return;
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await ownerSetFloristMorningCapacity(floristId, next);
      if (res.error) {
        setValue(prev);
        toast.error(res.error);
      }
    });
  }

  const btn = "inline-flex size-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 disabled:opacity-40";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>Успевает к 15:00:</span>
      <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-1 py-0.5">
        <button className={btn} onClick={() => change(value - 1)} disabled={pending || value <= 0} aria-label="Меньше">
          <Minus className="size-3.5" />
        </button>
        <span className="min-w-6 text-center font-medium text-slate-800">{value}</span>
        <button className={btn} onClick={() => change(value + 1)} disabled={pending || value >= 20} aria-label="Больше">
          <Plus className="size-3.5" />
        </button>
      </span>
      <span className="text-xs text-slate-400">маленький букет — 1, большой (от $250) — 2</span>
    </div>
  );
}
