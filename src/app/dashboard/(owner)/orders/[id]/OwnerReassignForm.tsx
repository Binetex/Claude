"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerReassign } from "@/app/dashboard/(owner)/actions";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

/**
 * Переназначение флориста. Своего триггера нет: форма живёт внутри модалки «Переназначить
 * флориста», которую открывают «Быстрые действия» — ровно как передача заказа у флориста.
 * Раньше это была отдельная большая карточка «Флорист и цена» в колонке управления.
 *
 * Заказ с РУЧНОЙ ценой переспрашивает, что делать с ценой: молча пересчитать её на авто —
 * значит потерять решение владельца, молча сохранить — значит применить цену одного флориста
 * к другому. Выбор оставлен человеку.
 */
export function OwnerReassignForm({
  orderId,
  florists,
  currentFloristId,
  priceMode,
  onDone,
}: {
  orderId: string;
  florists: { id: string; name: string }[];
  currentFloristId: string | null;
  priceMode: "AUTO" | "MANUAL";
  onDone?: () => void;
}) {
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  const options = florists.filter((f) => f.id !== currentFloristId);

  function doReassign(keepManual: boolean) {
    if (!target) return;
    start(async () => {
      await ownerReassign(orderId, target, keepManual);
      toast.success("Флорист переназначен");
      setConfirming(false);
      setTarget("");
      onDone?.();
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="reassign-target">Кому назначить</Label>
        <Select
          id="reassign-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending || options.length === 0}
        >
          <option value="">Выберите флориста…</option>
          {options.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </Select>
        <p className="text-xs text-slate-500">
          Заказ уйдёт выбранному флористу вместе с составом. Прежний перестанет его видеть.
        </p>
      </div>

      {confirming ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">У заказа ручная цена. Что сделать с ценой?</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => doReassign(true)}>Оставить ручную</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => doReassign(false)}>Авто-цена нового</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Отмена</Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={() => { setTarget(""); onDone?.(); }}>
            Отмена
          </Button>
          <Button
            disabled={pending || !target}
            onClick={() => (priceMode === "MANUAL" ? setConfirming(true) : doReassign(false))}
          >
            {pending ? "Назначаем…" : "Назначить"}
          </Button>
        </div>
      )}
    </div>
  );
}
