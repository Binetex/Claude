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
import { centsToUsdInput, formatCents } from "@/lib/cents";
import type { VaseCostType } from "@/generated/prisma/enums";
import { ownerAddVaseCost, ownerUpdateVaseCost, ownerDeleteVaseCost } from "@/app/dashboard/(owner)/actions";

export type VaseCostRowVM = {
  id: string;
  purchaseCostCents: number;
  effectiveFrom: string; // ISO
  effectiveTo: string | null;
  level: "VARIANT" | "PRODUCT";
  comment: string | null;
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: "UTC" });
const dateInput = (iso: string) => iso.slice(0, 10);

export function VaseCostEditor({
  target,
  costType,
  title,
  history,
  effectiveCostCents,
  effectiveSource,
  productId,
}: {
  target: { productId: string } | { productVariantId: string };
  costType: VaseCostType;
  title: string;
  history: VaseCostRowVM[];
  effectiveCostCents: number | null;
  effectiveSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  /** Для обновления страницы после правки. */
  productId: string;
}) {
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editFrom, setEditFrom] = useState("");
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const res = await ownerAddVaseCost({ target, costType, amountUsd: amount, effectiveFrom: from, comment });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Стоимость сохранена");
      setAmount("");
      setComment("");
      setOpen(false);
    });
  }

  function beginEdit(row: VaseCostRowVM) {
    setEditingId(row.id);
    setEditAmount(centsToUsdInput(row.purchaseCostCents));
    setEditFrom(dateInput(row.effectiveFrom));
  }

  function saveEdit() {
    if (!editingId) return;
    start(async () => {
      const res = await ownerUpdateVaseCost({ costId: editingId, amountUsd: editAmount, effectiveFrom: editFrom, productId });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Исправлено");
      setEditingId(null);
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

      {history.length > 0 && (
        <details className="mt-2" open={editingId != null}>
          <summary className="cursor-pointer list-none text-xs text-slate-500 hover:text-slate-700">
            История стоимости ({history.length})
          </summary>
          <ul className="mt-1 space-y-1 border-l border-slate-200 pl-2 text-[11px] text-slate-500">
            {history.map((h) =>
              editingId === h.id ? (
                <li key={h.id} className="space-y-1 py-1">
                  <div className="flex flex-wrap gap-2">
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={editAmount}
                      onChange={(e) => setEditAmount(e.target.value)}
                      className="w-28"
                    />
                    <Input type="date" value={editFrom} onChange={(e) => setEditFrom(e.target.value)} className="w-40" />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Исправление ошибки: прошлые расчёты по этому периоду изменятся. Если цена просто выросла —
                    закройте окно и добавьте новый интервал.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit} disabled={pending}>
                      Сохранить
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={pending}>
                      Отмена
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={h.id} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-slate-700">{formatCents(h.purchaseCostCents)}</span>
                  <span>
                    с {fmtDate(h.effectiveFrom)} {h.effectiveTo ? `по ${fmtDate(h.effectiveTo)}` : "— действует"}
                  </span>
                  {h.level === "PRODUCT" && <span className="text-slate-400">(товар)</span>}
                  {h.comment && <span className="text-slate-400">· {h.comment}</span>}
                  <button
                    type="button"
                    onClick={() => beginEdit(h)}
                    disabled={pending}
                    className="text-sky-600 hover:underline disabled:opacity-50"
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(h)}
                    disabled={pending}
                    className="text-red-600 hover:underline disabled:opacity-50"
                  >
                    Удалить
                  </button>
                </li>
              )
            )}
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
            Это изменение цены: предыдущий интервал закроется этой датой, прошлые заказы останутся по старой
            стоимости. Ошибку ввода правьте кнопкой «Изменить» в истории.
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
