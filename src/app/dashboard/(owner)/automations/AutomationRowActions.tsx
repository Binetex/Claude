"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleAutomation, duplicateAutomation, deleteAutomation } from "./actions";

export function AutomationRowActions({ id, active }: { id: string; active: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r?.error) alert(r.error);
      else router.refresh();
    });

  return (
    <div className="flex items-center justify-end gap-1 text-xs">
      <button
        disabled={pending}
        onClick={() => run(() => toggleAutomation(id, !active))}
        className="rounded border border-slate-300 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {active ? "Отключить" : "Включить"}
      </button>
      <button
        disabled={pending}
        onClick={() => run(() => duplicateAutomation(id))}
        className="rounded border border-slate-300 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        Дублировать
      </button>
      <button
        disabled={pending}
        onClick={() => {
          if (confirm("Удалить автоматизацию? Если есть история отправок — она будет скрыта (soft-delete), но записи сохранятся.")) run(() => deleteAutomation(id));
        }}
        className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
      >
        Удалить
      </button>
    </div>
  );
}
