"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import type { ClosureLevel } from "@/modules/timing/day";
import { setDayClosure } from "./actions";

const OPTIONS: { level: ClosureLevel | null; label: string; done: string }[] = [
  { level: null, label: "Открыт", done: "День открыт" },
  { level: "MORNING", label: "Утро закрыто", done: "Утро закрыто — раньше 15:00 не предлагаем" },
  { level: "DAY", label: "Только вечер", done: "Открыт только вечер — раньше 18:00 не предлагаем" },
  { level: "FULL", label: "Закрыт", done: "День закрыт — новых заказов на него не берём" },
];

/** Замок дня: одно нажатие — для всех флористов. Его видят ИИ и сайты с плагином доставки. */
export function DayLock({ day, level }: { day: string; level: ClosureLevel | null }) {
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label="Замок дня" className={cn("inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-200", pending && "opacity-50")}>
      {OPTIONS.map((o) => {
        const active = o.level === level;
        return (
          <button
            key={o.label}
            onClick={() => {
              if (active) return;
              start(async () => {
                const res = await setDayClosure(day, o.level);
                if (res.error) toast.error(res.error);
                else toast.success(o.done);
              });
            }}
            disabled={pending}
            aria-pressed={active}
            className={cn(
              "border-l border-slate-200 px-2.5 py-1.5 text-xs font-medium transition-colors first:border-l-0",
              active
                ? o.level
                  ? "bg-rose-50 text-rose-700"
                  : "bg-emerald-50 text-emerald-700"
                : "text-slate-600 hover:bg-slate-50"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
