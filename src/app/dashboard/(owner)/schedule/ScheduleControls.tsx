"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Lock, LockOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { setMorningClosure } from "./actions";

/** Замок дня: одно нажатие закрывает утро для всех флористов, второе открывает. */
export function MorningLock({ day, closed }: { day: string; closed: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      onClick={() => {
        start(async () => {
          const res = await setMorningClosure(day, !closed);
          if (res.error) toast.error(res.error);
          else toast.success(closed ? "Утро открыто" : "Утро закрыто — ИИ не будет его обещать");
        });
      }}
      disabled={pending}
      title={closed ? "Открыть утро" : "Закрыть утро на этот день"}
      aria-label={closed ? "Открыть утро" : "Закрыть утро"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
        closed ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-slate-200 text-slate-600 hover:bg-slate-50"
      )}
    >
      {closed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
      {closed ? "Открыть утро" : "Закрыть утро"}
    </button>
  );
}
