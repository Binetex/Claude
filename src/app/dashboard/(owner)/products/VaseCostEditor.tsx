"use client";
/**
 * Закупочная стоимость вазы: текущее значение, история интервалов и добавление нового.
 * Прямого редактирования строк нет — только новый интервал через ownerAddVaseCost, который
 * закрывает предыдущий. Дата начала обязательна, дата в будущем допустима.
 * Цена клиента сюда не попадает никогда: поле всегда пустое, без подстановки listPrice.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents } from "@/lib/cents";
import type { VaseCostType } from "@/generated/prisma/enums";
import { ownerAddVaseCost } from "@/app/dashboard/(owner)/actions";

export type VaseCostRowVM = {
  id: string;
  purchaseCostCents: number;
  effectiveFrom: string; // ISO
  effectiveTo: string | null;
  level: "VARIANT" | "PRODUCT";
  comment: string | null;
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: "UTC" });

export function VaseCostEditor({
  target,
  costType,
  title,
  history,
  effectiveCostCents,
  effectiveSource,
}: {
  target: { productId: string } | { productVariantId: string };
  costType: VaseCostType;
  title: string;
  history: VaseCostRowVM[];
  effectiveCostCents: number | null;
  effectiveSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
}) {
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const res = await ownerAddVaseCost({ target, costType, amountUsd: amount, effectiveFrom: from, comment });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Стоимость сохранена");
      setAmount("");
      setComment("");
      setOpen(false);
    });
  }

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>{title}</Label>
        <span className="text-sm font-semibold tabular-nums text-slate-800">
          {formatCents(effectiveCostCents)}
          {effectiveCostCents == null && <span className="ml-1 text-xs font-normal text-amber-600">не указана</span>}
          {effectiveCostCents != null && effectiveSource === "PRODUCT" && (
            <span className="ml-1 text-xs font-normal text-slate-400">от товара</span>
          )}
        </span>
      </div>

      {history.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-xs text-slate-500 hover:text-slate-700">
            История стоимости ({history.length})
          </summary>
          <ul className="mt-1 space-y-0.5 border-l border-slate-200 pl-2 text-[11px] text-slate-500">
            {history.map((h) => (
              <li key={h.id}>
                <span className="font-medium text-slate-700">{formatCents(h.purchaseCostCents)}</span>{" "}
                с {fmtDate(h.effectiveFrom)} {h.effectiveTo ? `по ${fmtDate(h.effectiveTo)}` : "— действует"}
                {h.level === "PRODUCT" && <span className="ml-1 text-slate-400">(товар)</span>}
                {h.comment && <span className="ml-1 text-slate-400">· {h.comment}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!open ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={() => setOpen(true)}>
          Добавить стоимость
        </Button>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className="flex-1">
              <span className="text-xs text-slate-500">Закупочная стоимость, $</span>
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="12.00"
                className="mt-1"
              />
            </label>
            <label className="flex-1">
              <span className="text-xs text-slate-500">Действует с</span>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1" />
            </label>
          </div>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (необязательно)" />
          <p className="text-[11px] text-slate-400">
            Предыдущий интервал закроется этой датой. Дату можно поставить в будущем — до неё действует текущая стоимость.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              Сохранить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
