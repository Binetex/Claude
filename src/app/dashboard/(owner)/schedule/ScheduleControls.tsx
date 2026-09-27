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
      onClick={(e) => {
        // Кнопка стоит в заголовке раскрывающейся строки — клик не должен её сворачивать.
        e.preventDefault();
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
        "rounded-md p-1.5 transition-colors disabled:opacity-50",
        closed ? "text-rose-600 hover:bg-rose-50" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      )}
    >
      {closed ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
    </button>
  );
}
