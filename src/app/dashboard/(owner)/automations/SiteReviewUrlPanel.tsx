"use client";
import { useState, useTransition } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { saveSiteReviewUrl, saveSiteAutomationDailyTime } from "./actions";

type SiteRow = { id: string; name: string; reviewUrl: string | null; quoEnabled: boolean; automationDailyLocalTime: string };

function Row({ site }: { site: SiteRow }) {
  const [value, setValue] = useState(site.reviewUrl ?? "");
  const [time, setTime] = useState(site.automationDailyLocalTime || "09:00");
  const [timeMsg, setTimeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 last:border-0">
      <div className="min-w-[140px] text-sm font-medium text-slate-700">{site.name}</div>
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setMsg(null); }}
        placeholder="https://…/review"
        className="min-w-[240px] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
      <button
        disabled={pending}
        onClick={() => start(async () => {
          const r = await saveSiteReviewUrl(site.id, value);
          setMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: "Сохранено" });
        })}
        className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        Сохранить
      </button>
      {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}

      <label className="flex items-center gap-1.5 text-xs text-slate-500">
        Ежедневные триггеры в
        <input
          type="time"
          value={time}
          onChange={(e) => { setTime(e.target.value); setTimeMsg(null); }}
          onBlur={() => start(async () => {
            const r = await saveSiteAutomationDailyTime(site.id, time);
            setTimeMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: "✓" });
          })}
          className="rounded-md border border-slate-300 px-1.5 py-1 text-sm text-slate-800"
        />
      </label>
      {timeMsg && <span className={timeMsg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{timeMsg.text}</span>}
    </div>
  );
}

export function SiteReviewUrlPanel({ sites }: { sites: SiteRow[] }) {
  return (
    <Card>
      <CardBody className="space-y-1">
        <div className="mb-1">
          <h2 className="text-sm font-semibold text-slate-800">Настройки по магазинам</h2>
          <p className="text-xs text-slate-500">Ссылка используется как переменная <code className="rounded bg-slate-100 px-1">{"{{review_url}}"}</code> — без неё review-правила не отправляются. Время — когда срабатывают ежедневные триггеры («Доставка сегодня») по местному времени магазина.</p>
        </div>
        {sites.map((s) => <Row key={s.id} site={s} />)}
      </CardBody>
    </Card>
  );
}
