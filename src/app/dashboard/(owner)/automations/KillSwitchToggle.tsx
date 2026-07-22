"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setKillSwitch } from "./actions";

/** Глобальный рубильник автоматизаций. При включённом «стопе» движок не создаёт и не шлёт job'ы. */
export function KillSwitchToggle({ disableAll, updatedAt }: { disableAll: boolean; updatedAt: string | null }) {
  const [on, setOn] = useState(disableAll);
  const [pending, start] = useTransition();
  const router = useRouter();

  function toggle(next: boolean) {
    start(async () => {
      const r = await setKillSwitch(next);
      if (r?.error) { alert(r.error); return; }
      setOn(next);
      router.refresh();
    });
  }

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${on ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
      <div>
        <div className="text-sm font-semibold text-slate-800">
          Глобальный стоп автоматизаций {on ? <span className="text-red-700">— ВКЛЮЧЁН</span> : <span className="text-emerald-700">— выключен</span>}
        </div>
        <p className="text-xs text-slate-500">
          Когда включён, ни одно правило не создаёт и не отправляет сообщений (аварийный рубильник).
          {updatedAt ? ` Изменён: ${new Date(updatedAt).toLocaleString("ru-RU")}.` : ""}
        </p>
      </div>
      <button
        disabled={pending}
        onClick={() => toggle(!on)}
        className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${on ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}`}
      >
        {on ? "Снять стоп" : "Остановить все автоматизации"}
      </button>
    </div>
  );
}
