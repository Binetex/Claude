"use client";
import { useState, useTransition } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { saveSiteAutomationDailyTime } from "./actions";
import { DEFAULT_DAILY_LOCAL_TIME } from "@/modules/automations/dailySchedule";

type SiteRow = { id: string; name: string; quoEnabled: boolean; automationDailyLocalTime: string };

function Row({ site }: { site: SiteRow }) {
  const [time, setTime] = useState(site.automationDailyLocalTime || DEFAULT_DAILY_LOCAL_TIME);
  const [timeMsg, setTimeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 last:border-0">
      <div className="min-w-[140px] text-sm font-medium text-slate-700">{site.name}</div>
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
          <p className="text-xs text-slate-500">
            Когда срабатывают ежедневные триггеры («Доставка сегодня») по местному времени магазина.
            Ссылка на отзыв живёт в разделе <b>Отзывы</b>: переменная{" "}
            <code className="rounded bg-slate-100 px-1">{"{{review_url}}"}</code> берёт ближайшую к адресу точку.
          </p>
        </div>
        {sites.map((s) => <Row key={s.id} site={s} />)}
      </CardBody>
    </Card>
  );
}
