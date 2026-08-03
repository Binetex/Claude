"use client";
/** Фильтры очереди и ручной прогон детектора. Значения фильтров живут в URL. */
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { rescanFinanceIssues } from "./setupActions";

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "DELIVERY_ACTUAL_COST_MISSING", label: "Нет фактической доставки" },
  { value: "ACQUIRING_FEE_MODEL_MISSING", label: "Нет модели комиссии" },
  { value: "DAILY_FLOWER_EXPENSE_MISSING", label: "Нет дневной закупки" },
  { value: "VASE_COST_MISSING", label: "Нет стоимости вазы" },
  { value: "GIFT_COST_MISSING", label: "Нет стоимости подарка" },
  { value: "VASE_LINK_MISSING", label: "Ваза не привязана" },
  { value: "CONSUMABLES_RATE_MISSING", label: "Нет ставки расходников" },
  { value: "OWNER_TAX_POLICY_MISSING", label: "Нет налоговой политики" },
];

const GROUP_OPTIONS = [
  { value: "TODAY", label: "Сегодня" },
  { value: "LAST_7_DAYS", label: "7 дней" },
  { value: "OLDER", label: "Старые" },
  { value: "NO_DATE", label: "Без даты" },
];

export function SetupFilters({
  sites,
  current,
}: {
  sites: { id: string; shortName: string }[];
  current: { site?: string; type?: string; group?: string };
}) {
  const router = useRouter();

  function apply(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    router.push(`/dashboard/finance/setup${s ? `?${s}` : ""}`);
  }

  const select = "h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs shadow-xs";
  const hasFilters = Boolean(current.site || current.type || current.group);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={select} value={current.group ?? ""} onChange={(e) => apply({ group: e.target.value || undefined })}>
        <option value="">Все даты</option>
        {GROUP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select className={select} value={current.site ?? ""} onChange={(e) => apply({ site: e.target.value || undefined })}>
        <option value="">Все магазины</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.shortName}
          </option>
        ))}
      </select>

      <select className={select} value={current.type ?? ""} onChange={(e) => apply({ type: e.target.value || undefined })}>
        <option value="">Все типы проблем</option>
        {TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/finance/setup")}>
          Сбросить
        </Button>
      )}
    </div>
  );
}

export function RescanButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await rescanFinanceIssues();
          if (res.error) toast.error(res.error);
          else toast.success(res.message ?? "Готово");
        })
      }
    >
      {pending ? "Проверяю…" : "Проверить заново"}
    </Button>
  );
}
