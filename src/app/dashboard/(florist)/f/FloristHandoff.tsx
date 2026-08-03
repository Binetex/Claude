"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { floristHandoff } from "@/app/dashboard/(florist)/actions";

const REASONS: Record<string, string> = {
  no_target: "Выберите флориста.",
  same_florist: "Нельзя передать самому себе.",
  order_not_found: "Заказ не найден.",
  not_current_florist: "Заказ уже не за вами.",
  not_assignable: "Передать можно только до принятия заказа.",
  target_unavailable: "Выбранный флорист недоступен.",
};

/**
 * Форма передачи заказа другому активному флористу (замена простого «Отказаться»).
 *
 * Своего триггера у неё нет: форма живёт внутри модалки «Передать заказ», которую
 * открывают «Быстрые действия». Второго входа в этот сценарий на странице быть не должно.
 *
 * `florists` — активные, кроме себя.
 */
export function FloristHandoff({
  orderId,
  florists,
  onDone,
}: {
  orderId: string;
  florists: { id: string; name: string }[];
  /** Закрыть внешнюю модалку — после успешной передачи и по «Отмена». */
  onDone?: () => void;
}) {
  const [target, setTarget] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const r = await floristHandoff(orderId, target);
      if (r?.ok) {
        toast.success("Заказ передан");
        setTarget("");
        onDone?.();
      } else {
        toast.error(REASONS[r?.reason ?? ""] ?? "Не удалось передать заказ");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="handoff-target">Кому передать</Label>
        <Select
          id="handoff-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={pending || florists.length === 0}
        >
          <option value="">Выберите флориста…</option>
          {florists.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </Select>
        <p className="text-xs text-slate-500">
          Заказ уйдёт выбранному флористу вместе с ценой и составом. Вы перестанете его видеть.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={() => { setTarget(""); onDone?.(); }}>
          Отмена
        </Button>
        <Button disabled={pending || !target} onClick={submit}>
          {pending ? "Передаём…" : "Передать заказ"}
        </Button>
      </div>
    </div>
  );
}
