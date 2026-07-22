"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ownerSetSiteBurqDropoff } from "./actions";

/**
 * «Default Burq dropoff instructions» — единый текст, автоматически добавляемый в dropoff.notes
 * всех НОВЫХ Burq draft этого магазина. Отдельно для каждого Site. Пусто → выключено.
 * Существующие draft не меняются.
 */
export function SiteBurqDropoffSetting({ siteId, current }: { siteId: string; current: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = value.trim() !== (current ?? "").trim();

  return (
    <div className="space-y-1.5 border-t border-slate-100 pt-3">
      <div className="text-xs text-slate-400">Default Burq dropoff instructions</div>
      <p className="text-[11px] text-slate-400">
        Добавляется в каждый новый Burq draft этого магазина. Пусто — выключено. Существующие draft не меняются.
      </p>
      <textarea
        value={value}
        onChange={(e) => { setValue(e.target.value); setMsg(null); }}
        rows={3}
        placeholder="CALL OR TEXT THE RECIPIENT WHEN YOU ARRIVE. DO NOT LEAVE THE FLOWERS OUTSIDE WITHOUT CONFIRMATION."
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        aria-label="Default Burq dropoff instructions"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              const r = await ownerSetSiteBurqDropoff(siteId, value);
              setMsg(r?.ok ? { ok: true, text: r.message ?? "Сохранено" } : { ok: false, text: r?.error ?? "Ошибка" });
            })
          }
        >
          {pending ? "…" : "Сохранить инструкцию"}
        </Button>
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>
    </div>
  );
}
