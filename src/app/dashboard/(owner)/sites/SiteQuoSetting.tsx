"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  ownerQuoListNumbers,
  ownerQuoSaveNumber,
  ownerQuoSaveManual,
  ownerQuoCheckConnection,
  ownerQuoSetEnabled,
  ownerQuoUnlink,
  type QuoNumberOption,
} from "./quoActions";

export type SiteQuoState = {
  quoPhoneNumberId: string | null;
  quoPhoneNumber: string | null;
  quoEnabled: boolean;
  quoLastCheckAt: string | null;
  quoConnectionError: string | null;
};

function statusMeta(s: SiteQuoState): { label: string; cls: string } {
  if (!s.quoPhoneNumberId) return { label: "Не настроено", cls: "bg-slate-100 text-slate-600 border-slate-200" };
  if (!s.quoEnabled) return { label: "Отключено", cls: "bg-amber-100 text-amber-800 border-amber-200" };
  if (s.quoConnectionError) return { label: "Ошибка", cls: "bg-red-100 text-red-800 border-red-200" };
  return { label: "Подключено", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" };
}

/** Блок «QUO / SMS и звонки» — привязка QUO-номера к магазину. Owner-only (в actions). */
export function SiteQuoSetting({ siteId, current }: { siteId: string; current: SiteQuoState }) {
  const [numbers, setNumbers] = useState<QuoNumberOption[] | null>(null);
  const [selected, setSelected] = useState(current.quoPhoneNumberId ?? "");
  const [manualId, setManualId] = useState("");
  const [manualNum, setManualNum] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const st = statusMeta(current);

  function run(fn: () => Promise<{ ok?: true; error?: string }>, okText: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: okText });
    });
  }

  function refreshNumbers() {
    setMsg(null);
    start(async () => {
      const r = await ownerQuoListNumbers();
      if (r.error) { setMsg({ ok: false, text: r.error }); return; }
      setNumbers(r.numbers ?? []);
      setMsg({ ok: true, text: `Загружено номеров: ${r.numbers?.length ?? 0}` });
    });
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">QUO / SMS и звонки</span>
        <span className={`rounded border px-1.5 py-px text-[10px] font-medium ${st.cls}`}>{st.label}</span>
      </div>

      {/* Текущая привязка / диагностика */}
      <div className="grid grid-cols-1 gap-1 text-[11px] text-slate-500 sm:grid-cols-2">
        <div>Номер: <span className="text-slate-800">{current.quoPhoneNumber || "—"}</span></div>
        <div>Phone Number ID: <span className="font-mono text-slate-700">{current.quoPhoneNumberId || "—"}</span></div>
        <div>Последняя проверка: <span className="text-slate-700">{current.quoLastCheckAt ? new Date(current.quoLastCheckAt).toLocaleString("ru-RU") : "—"}</span></div>
        {current.quoConnectionError && <div className="text-amber-700 sm:col-span-2">⚠ {current.quoConnectionError}</div>}
      </div>

      {/* Тумблер включения */}
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={current.quoEnabled}
          disabled={pending}
          onChange={(e) => run(() => ownerQuoSetEnabled(siteId, e.target.checked), e.target.checked ? "QUO включён" : "QUO выключен")}
        />
        QUO включён для магазина
      </label>

      {/* Выбор номера из списка */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1 space-y-1">
          <label className="text-xs text-slate-400">Номер телефона QUO</label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={pending || !numbers}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
          >
            {!numbers && <option value="">Нажмите «Обновить список номеров»</option>}
            {numbers && numbers.length === 0 && <option value="">Номеров не найдено</option>}
            {numbers && numbers.length > 0 && <option value="">Выберите номер…</option>}
            {numbers?.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
        </div>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={refreshNumbers}>Обновить список номеров</Button>
      </div>

      {/* Действия */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={pending || !selected} onClick={() => run(() => ownerQuoSaveNumber(siteId, selected), "Номер сохранён и QUO включён")}>Сохранить</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || !current.quoPhoneNumberId} onClick={() => run(() => ownerQuoCheckConnection(siteId), "Подключение в порядке")}>Проверить подключение</Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || !current.quoPhoneNumberId}
          onClick={() => { if (confirm("Отвязать номер QUO от этого магазина? Отправка SMS отключится. История сообщений сохранится.")) run(() => ownerQuoUnlink(siteId), "Номер отвязан"); }}
        >
          Отвязать номер
        </Button>
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>

      {/* Ручной ввод — на случай, если list endpoint недоступен */}
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer select-none">Дополнительно (ручной ввод ID)</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="space-y-1"><label className="text-slate-400">Phone Number ID</label><input value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="PN…" className="rounded-md border border-slate-300 px-2 py-1 text-sm" /></div>
          <div className="space-y-1"><label className="text-slate-400">Номер (E.164)</label><input value={manualNum} onChange={(e) => setManualNum(e.target.value)} placeholder="+1310…" className="rounded-md border border-slate-300 px-2 py-1 text-sm" /></div>
          <Button type="button" size="sm" variant="outline" disabled={pending || !manualId.trim()} onClick={() => run(() => ownerQuoSaveManual(siteId, manualId, manualNum), "Сохранено вручную")}>Сохранить вручную</Button>
        </div>
        <p className="mt-1 text-[10px] text-amber-600">Без проверки через QUO API. Используйте, только если список номеров не загружается.</p>
      </details>
    </div>
  );
}
