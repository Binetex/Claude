"use client";
import { cn } from "@/lib/cn";
import { windowOptions, fmtHm, type WindowRange } from "@/lib/deliveryWindow";

/**
 * Выбор окна доставки строго «с — до»: кнопки со слотами магазина и два списка с шагом 30 минут.
 * Свободного текста нет — «желательно первым» и прочие пожелания пишутся в заметку, а не в окно.
 */
export function WindowPicker({
  value,
  onChange,
  presets,
  disabled,
}: {
  value: WindowRange | null;
  onChange: (next: WindowRange | null) => void;
  /** Частые окна магазина — одним нажатием. */
  presets: WindowRange[];
  disabled?: boolean;
}) {
  const options = windowOptions([value?.from, value?.to]);
  const same = (a: WindowRange, b: WindowRange | null) => !!b && a.from === b.from && a.to === b.to;

  function setFrom(raw: string) {
    if (raw === "") return onChange(null);
    const from = Number(raw);
    // «До» не может быть раньше «с»: подтягиваем его на шаг вперёд, а не показываем ошибку.
    const to = value && value.to > from ? value.to : Math.min(from + 240, 24 * 60);
    onChange({ from, to });
  }
  function setTo(raw: string) {
    if (raw === "") return onChange(null);
    const to = Number(raw);
    const from = value && value.from < to ? value.from : Math.max(to - 240, 0);
    onChange({ from, to });
  }

  const select = "h-9 rounded-md border border-slate-200 bg-white px-2 text-sm tabular-nums disabled:opacity-50";
  return (
    <div className="space-y-2">
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={`${p.from}-${p.to}`}
              type="button"
              disabled={disabled}
              onClick={() => onChange(p)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-sm tabular-nums transition-colors disabled:opacity-50",
                same(p, value) ? "border-sky-300 bg-sky-50 text-sky-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"
              )}
            >
              {fmtHm(p.from)} – {fmtHm(p.to)}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <span>с</span>
        <select className={select} value={value?.from ?? ""} onChange={(e) => setFrom(e.target.value)} disabled={disabled} aria-label="Доставка с">
          <option value="">—</option>
          {options.filter((m) => m < 24 * 60).map((m) => (
            <option key={m} value={m}>{fmtHm(m)}</option>
          ))}
        </select>
        <span>до</span>
        <select className={select} value={value?.to ?? ""} onChange={(e) => setTo(e.target.value)} disabled={disabled} aria-label="Доставка до">
          <option value="">—</option>
          {options.filter((m) => m > 0).map((m) => (
            <option key={m} value={m}>{fmtHm(m)}</option>
          ))}
        </select>
      </div>
      {!value && <div className="text-xs text-amber-600">время не задано</div>}
    </div>
  );
}
