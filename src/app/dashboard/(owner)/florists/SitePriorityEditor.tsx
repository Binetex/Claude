"use client";
import { useState, useTransition } from "react";
import {
  ownerAddSitePriority,
  ownerRemoveSitePriority,
  ownerMoveSitePriority,
  ownerAssignPendingForSite,
} from "@/app/dashboard/(owner)/actions";

type PriorityRow = { floristId: string; name: string; position: number };

export function SitePriorityEditor({
  siteId,
  priorities,
  allFlorists,
  unassignedCount,
}: {
  siteId: string;
  priorities: PriorityRow[];
  allFlorists: { id: string; name: string }[];
  unassignedCount: number;
}) {
  const [pending, start] = useTransition();
  const [assignMessage, setAssignMessage] = useState<string | null>(null);
  const available = allFlorists.filter((f) => !priorities.some((p) => p.floristId === f.id));
  const [selected, setSelected] = useState(available[0]?.id ?? "");
  // `available` меняется после каждого add/remove (новые props с сервера) — если то, что
  // сейчас выбрано, больше не входит в список доступных (уже добавлено или список пуст),
  // сбрасываем на первый доступный вариант, иначе кнопка "Добавить" отправит устаревший id.
  const effectiveSelected = available.some((f) => f.id === selected) ? selected : (available[0]?.id ?? "");

  function add() {
    if (!effectiveSelected || pending) return;
    start(() => ownerAddSitePriority(siteId, effectiveSelected));
  }

  function remove(floristId: string) {
    if (pending) return;
    start(() => ownerRemoveSitePriority(siteId, floristId));
  }

  function move(floristId: string, direction: "up" | "down") {
    if (pending) return;
    start(() => ownerMoveSitePriority(siteId, floristId, direction));
  }

  function assignPending() {
    if (pending) return;
    start(async () => {
      const result = await ownerAssignPendingForSite(siteId);
      setAssignMessage(`Назначено: ${result.assigned}`);
    });
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-1 text-sm">
        {priorities.map((p, i) => (
          <li key={p.floristId} className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-xs text-white">{i + 1}</span>
            <span className="flex-1 text-slate-700">{p.name}</span>
            {i === 0 && <span className="text-xs text-emerald-600">основной</span>}
            <button
              onClick={() => move(p.floristId, "up")}
              disabled={pending || i === 0}
              className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              aria-label="Выше"
            >
              ▲
            </button>
            <button
              onClick={() => move(p.floristId, "down")}
              disabled={pending || i === priorities.length - 1}
              className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              aria-label="Ниже"
            >
              ▼
            </button>
            <button
              onClick={() => remove(p.floristId)}
              disabled={pending}
              className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 disabled:opacity-30"
              aria-label="Убрать"
            >
              ✕
            </button>
          </li>
        ))}
        {priorities.length === 0 && <li className="text-xs text-slate-400">Приоритет не задан</li>}
      </ol>

      {available.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={effectiveSelected}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
          >
            {available.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button
            onClick={add}
            disabled={pending}
            className="rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Добавить
          </button>
        </div>
      )}

      {unassignedCount > 0 && priorities.length > 0 && (
        <div className="flex items-center gap-2 border-t border-slate-100 pt-2">
          <button
            onClick={assignPending}
            disabled={pending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Назначить {unassignedCount} неназначенных заказов основному
          </button>
          {assignMessage && <span className="text-xs text-slate-500">{assignMessage}</span>}
        </div>
      )}
    </div>
  );
}
