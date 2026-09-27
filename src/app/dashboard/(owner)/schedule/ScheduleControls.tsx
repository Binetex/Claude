"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Lock, LockOpen, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { setMorningClosure, setFloristMorningCapacity } from "./actions";

/**
 * «Утро закрыто» на дату — ручное решение владельца (нет флориста, праздник). Закрытие по
 * загрузке считается само и здесь не нужно.
 */
export function MorningClosureToggle({ day, closed, note }: { day: string; closed: boolean; note: string | null }) {
  const [pending, start] = useTransition();
  const [text, setText] = useState(note ?? "");

  function apply(next: boolean) {
    start(async () => {
      const res = await setMorningClosure(day, next, text);
      if (res.error) toast.error(res.error);
      else toast.success(next ? "Утро закрыто — ассистент не будет его обещать" : "Утро снова открыто");
    });
  }

  if (closed) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
        <Lock aria-hidden className="size-4" />
        <span className="font-medium">Утро закрыто вручную</span>
        {note && <span className="text-rose-700">· {note}</span>}
        <button
          onClick={() => apply(false)}
          disabled={pending}
          className="ml-auto rounded-md bg-white px-2.5 py-1 text-xs font-medium text-rose-700 shadow-xs hover:bg-rose-100 disabled:opacity-50"
        >
          Открыть утро
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Причина (необязательно)"
        maxLength={200}
        className="h-8 w-56 rounded-md border border-slate-200 px-2 text-sm placeholder:text-slate-400"
      />
      <button
        onClick={() => apply(true)}
        disabled={pending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <LockOpen aria-hidden className="size-4 text-slate-400" />
        Закрыть утро на этот день
      </button>
    </div>
  );
}

/** Лимит утра флориста в баллах: ± по одному, сохраняется сразу. */
export function CapacityStepper({ floristId, capacity }: { floristId: string; capacity: number }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(capacity);

  function change(next: number) {
    if (next < 0 || next > 20) return;
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await setFloristMorningCapacity(floristId, next);
      if (res.error) {
        setValue(prev);
        toast.error(res.error);
      }
    });
  }

  const btn = "inline-flex size-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 disabled:opacity-40";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-lg bg-slate-100 px-1 py-0.5 text-xs", pending && "opacity-60")}>
      <button className={btn} onClick={() => change(value - 1)} disabled={pending || value <= 0} aria-label="Меньше">
        <Minus className="size-3.5" />
      </button>
      <span className="min-w-14 text-center font-medium text-slate-700">лимит {value}</span>
      <button className={btn} onClick={() => change(value + 1)} disabled={pending || value >= 20} aria-label="Больше">
        <Plus className="size-3.5" />
      </button>
    </span>
  );
}
