"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ownerSetSiteBurqAutoCreate } from "./actions";

/**
 * Автосоздание Burq-черновиков для магазина (Site.burqDraftAutoCreateEnabled).
 *
 * Переключателя тут не было вовсе: в схеме стоит default(false), и новый магазин молча
 * оставался без автодоставок, пока кто-нибудь не проставит флаг руками в БД. Именно так и
 * получилось, что пять старых магазинов работали, а свежеподключённый — нет, и понять
 * причину из интерфейса было невозможно.
 *
 * Новые магазины теперь подключаются сразу включёнными; этот переключатель нужен, чтобы
 * состояние было ВИДНО и чтобы его можно было менять, не заходя в базу.
 */
export function SiteBurqAutoCreateSetting({ siteId, enabled }: { siteId: string; enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function toggle() {
    const next = !on;
    start(async () => {
      const r = await ownerSetSiteBurqAutoCreate(siteId, next);
      if (r?.ok) {
        setOn(next);
        setMsg({ ok: true, text: r.message ?? "Сохранено" });
      } else {
        setMsg({ ok: false, text: r?.error ?? "Ошибка" });
      }
    });
  }

  return (
    <div className="space-y-1.5 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-slate-400">Автосоздание доставок Burq</div>
          <div className={`text-sm font-medium ${on ? "text-emerald-700" : "text-slate-500"}`}>
            {on ? "Включено" : "Выключено"}
          </div>
        </div>
        <Button type="button" size="sm" variant={on ? "ghost" : "outline"} disabled={pending} onClick={toggle}>
          {pending ? "…" : on ? "Выключить" : "Включить"}
        </Button>
      </div>
      <p className="text-[11px] text-slate-400">
        Черновик доставки создаётся сам в {"04:00"} локального дня доставки, когда назначен флорист и
        настроена точка забора. Заказы с прошедшей датой не создаются.
      </p>
      {msg && <p className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</p>}
    </div>
  );
}
