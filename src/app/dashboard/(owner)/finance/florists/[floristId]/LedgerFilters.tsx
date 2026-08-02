"use client";
/**
 * Фильтр истории по периоду и типу операции. Значения живут в URL — ссылку на
 * «удержания за июль» можно отправить, и она откроется тем же экраном.
 */
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ledgerTypeMeta } from "@/components/finance/LedgerTable";
import type { LedgerEntryType } from "@/generated/prisma/enums";

const TYPE_OPTIONS = Object.entries(ledgerTypeMeta) as [LedgerEntryType, { label: string }][];

export function LedgerFilters({
  floristId,
  from,
  to,
  type,
}: {
  floristId: string;
  from?: string;
  to?: string;
  type?: string;
}) {
  const router = useRouter();

  function apply(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ from, to, type, ...patch })) if (v) p.set(k, v);
    // Страница сбрасывается: третьей страницы у нового фильтра может не быть.
    const s = p.toString();
    router.push(`/dashboard/finance/florists/${floristId}${s ? `?${s}` : ""}`);
  }

  const hasFilters = Boolean(from || to || type);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="date"
        defaultValue={from ?? ""}
        onChange={(e) => apply({ from: e.target.value || undefined })}
        className="h-8 w-auto text-xs"
        aria-label="Период с"
      />
      <span className="text-xs text-slate-400">—</span>
      <Input
        type="date"
        defaultValue={to ?? ""}
        onChange={(e) => apply({ to: e.target.value || undefined })}
        className="h-8 w-auto text-xs"
        aria-label="Период по"
      />
      <select
        value={type ?? ""}
        onChange={(e) => apply({ type: e.target.value || undefined })}
        className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs shadow-xs"
        aria-label="Тип операции"
      >
        <option value="">Все операции</option>
        {TYPE_OPTIONS.map(([value, meta]) => (
          <option key={value} value={value}>
            {meta.label}
          </option>
        ))}
      </select>
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/finance/florists/${floristId}`)}
        >
          Сбросить
        </Button>
      )}
    </div>
  );
}
