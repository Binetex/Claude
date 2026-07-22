"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
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
 * Передача заказа выбранному активному флористу (замена простого «Отказаться»). Флорист выбирает,
 * кому передать (как владелец при переназначении). `florists` — активные, кроме себя.
 */
export function FloristHandoff({ orderId, florists, btnClass = "" }: { orderId: string; florists: { id: string; name: string }[]; btnClass?: string }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        disabled={florists.length === 0}
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        className={btnClass}
        title={florists.length === 0 ? "Нет других активных флористов" : undefined}
      >
        {florists.length === 0 ? "Некому передать" : "Передать…"}
      </button>
    );
  }

  return (
    <div className="col-span-2 space-y-2" onClick={(e) => e.preventDefault()}>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
        aria-label="Кому передать заказ"
      >
        <option value="">Кому передать заказ…</option>
        {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending || !target}
          onClick={() =>
            start(async () => {
              const r = await floristHandoff(orderId, target);
              if (r?.ok) { toast.success("Заказ передан"); setOpen(false); setTarget(""); }
              else toast.error(REASONS[r?.reason ?? ""] ?? "Не удалось передать заказ");
            })
          }
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
        >
          {pending ? "…" : "Передать"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => { setOpen(false); setTarget(""); }}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
