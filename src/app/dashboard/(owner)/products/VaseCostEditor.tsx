"use client";
/**
 * Закупочная стоимость вазы: текущее значение, история интервалов, добавление нового и
 * исправление ошибочного.
 *
 * Две РАЗНЫЕ операции, и их важно не путать:
 *   «Добавить стоимость» — цена изменилась с какой-то даты. Прошлые заказы считаются по старой.
 *   «Изменить»/«Удалить»  — ошибка ввода. Прошлое пересчитывается, потому что такой цены не было.
 * Обе пишутся в аудит, поэтому правка не теряется.
 *
 * Цена клиента сюда не попадает никогда: поле всегда пустое, без подстановки listPrice.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents } from "@/lib/cents";
import type { VaseCostType } from "@/generated/prisma/enums";
import { ownerAddVaseCost, ownerDeleteVaseCost } from "@/app/dashboard/(owner)/actions";

export type VaseCostRowVM = {
  id: string;
  purchaseCostCents: number;
  level: "VARIANT" | "PRODUCT";
  comment: string | null;
};

export function VaseCostEditor({
  target,
  costType,
  title,
  rows,
  effectiveCostCents,
  effectiveSource,
  productId,
}: {
  target: { productId: string } | { productVariantId: string };
  costType: VaseCostType;
  title: string;
  rows: VaseCostRowVM[];
  effectiveCostCents: number | null;
  effectiveSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  /** Для обновления страницы после правки. */
  productId: string;
}) {
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const res = await ownerAddVaseCost({ target, costType, amountUsd: amount, comment });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Стоимость сохранена");
      setAmount("");
      setComment("");
      setOpen(false);
    });
  }

  function remove(row: VaseCostRowVM) {
    start(async () => {
      const res = await ownerDeleteVaseCost({ costId: row.id, productId });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Запись удалена");
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

      {rows.length > 0 && (
        <ul className="mt-2 space-y-1 border-l border-slate-200 pl-2 text-[11px] text-slate-500">
          {rows.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-slate-700">{formatCents(h.purchaseCostCents)}</span>
              {h.level === "PRODUCT" && <span className="text-slate-400">(товар)</span>}
              {h.comment && <span className="text-slate-400">· {h.comment}</span>}
              <button
                type="button"
                onClick={() => remove(h)}
                disabled={pending}
                className="text-red-600 hover:underline disabled:opacity-50"
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={() => setOpen(true)}>
          {rows.length > 0 ? "Изменить стоимость" : "Указать стоимость"}
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
          </div>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (необязательно)" />
          <p className="text-[11px] text-slate-400">
            Стоимость одна и действует всегда. Дни, где ваза уже участвовала в расчёте, пересчитаются по новой
            сумме; прежняя останется в истории правок.
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
