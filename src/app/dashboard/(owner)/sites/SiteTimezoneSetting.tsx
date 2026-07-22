"use client";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ownerSetSiteTimezone } from "./actions";

const DEFAULT_TZ = "America/Los_Angeles";

/** Полный список IANA-таймзон (с фолбэком, если рантайм не поддерживает supportedValuesOf). */
function ianaZones(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof sv === "function") return sv("timeZone");
  } catch {
    /* ignore */
  }
  return ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin"];
}

/**
 * Ручная настройка «Часовой пояс магазина» (Site.timezone). Показывается для любого сайта после
 * подключения. Значение задаёт владелец; из API не подтягивается.
 */
export function SiteTimezoneSetting({ siteId, current }: { siteId: string; current: string | null }) {
  const zones = useMemo(() => ianaZones(), []);
  const [value, setValue] = useState(current ?? DEFAULT_TZ);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = value !== (current ?? DEFAULT_TZ) || current == null;

  return (
    <div className="space-y-1.5 border-t border-slate-100 pt-3">
      <div className="text-xs text-slate-400">Часовой пояс магазина</div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-700">
          Часовой пояс: <b>{current ?? "— (по умолчанию America/Los_Angeles)"}</b>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value}
          onChange={(e) => { setValue(e.target.value); setMsg(null); }}
          className="max-w-[16rem] rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          aria-label="Часовой пояс магазина"
        >
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              const r = await ownerSetSiteTimezone(siteId, value);
              setMsg(r?.ok ? { ok: true, text: r.message ?? "Сохранено" } : { ok: false, text: r?.error ?? "Ошибка" });
            })
          }
        >
          {pending ? "…" : "Сохранить пояс"}
        </Button>
      </div>
      {msg && <p className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</p>}
    </div>
  );
}
