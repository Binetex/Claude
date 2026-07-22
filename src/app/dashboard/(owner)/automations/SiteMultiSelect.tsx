"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export type SiteOption = { id: string; name: string; quoEnabled: boolean };

/** Подпись выбора: «Все магазины (10)» / перечисление имён / «Магазины не выбраны». */
export function siteSelectionLabel(sites: SiteOption[], selected: string[]): string {
  if (selected.length === 0) return "Магазины не выбраны";
  if (sites.length > 0 && selected.length === sites.length) return `Все магазины (${sites.length})`;
  const byId = new Map(sites.map((s) => [s.id, s.name]));
  return selected.map((id) => byId.get(id) ?? id).join(", ");
}

export function SiteMultiSelect({
  sites,
  selected,
  onChange,
  disabled,
}: {
  sites: SiteOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // Клик вне списка закрывает его.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sites.filter((s) => s.name.toLowerCase().includes(q)) : sites;
  }, [sites, query]);

  const selectedSet = new Set(selected);
  const allSelected = sites.length > 0 && selected.length === sites.length;

  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-300 px-2 py-1.5 text-left text-sm disabled:bg-slate-50"
      >
        <span className={selected.length ? "truncate text-slate-800" : "truncate text-slate-400"}>
          {allSelected ? `Все магазины (${sites.length})` : selected.length ? `Выбрано: ${selected.length}` : "Выберите магазины…"}
        </span>
        <span className="shrink-0 text-slate-400">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск магазина…"
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5">
            <button type="button" onClick={() => onChange(sites.map((s) => s.id))} className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">
              Выбрать все
            </button>
            <button type="button" onClick={() => onChange([])} className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">
              Очистить
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">Ничего не найдено</p>}
            {filtered.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                <input type="checkbox" className="h-4 w-4" checked={selectedSet.has(s.id)} onChange={() => toggle(s.id)} />
                <span className="truncate">{s.name}</span>
                {!s.quoEnabled && <span className="ml-auto shrink-0 text-[11px] text-amber-600">QUO выключен</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Выбранные — тегами, с быстрым снятием. */}
      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {allSelected ? (
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">Все магазины ({sites.length})</span>
          ) : (
            selected.map((id) => {
              const s = sites.find((x) => x.id === id);
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">
                  {s?.name ?? id}
                  {!disabled && (
                    <button type="button" onClick={() => toggle(id)} className="text-slate-400 hover:text-slate-700" aria-label={`Убрать ${s?.name ?? id}`}>
                      ×
                    </button>
                  )}
                </span>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
