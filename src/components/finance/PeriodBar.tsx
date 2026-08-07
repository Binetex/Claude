"use client";
/**
 * Переключатель периода страницы «Магазины».
 *
 * Период живёт в адресе, а не в состоянии: ссылку на «неделю по THEFLOW» можно отправить
 * себе же, и обновление страницы её не теряет.
 */
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { PERIOD_TABS, type PeriodKind } from "@/modules/finance/period";
import { cn } from "@/lib/cn";

export function FinancePeriodBar({ current }: { current: PeriodKind }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(`${pathname}?${p.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
        {PERIOD_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            // Диапазон сбрасываем: иначе вкладка подсвечена одна, а показан период другой.
            onClick={() => go({ period: t.key, from: undefined, to: undefined })}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              current === t.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <DateRangePicker
        value={{ from: params.get("from") ?? undefined, to: params.get("to") ?? undefined }}
        placeholder="Выбрать даты"
        onChange={(next) => go({ period: "range", from: next.from, to: next.to })}
      />
    </div>
  );
}
