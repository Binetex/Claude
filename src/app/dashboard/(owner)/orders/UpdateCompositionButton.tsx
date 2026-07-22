"use client";
import { useTransition, useState } from "react";
import { ownerUpdateOrderItemComposition } from "@/app/dashboard/(owner)/actions";

/** Владелец: обновить snapshot состава позиции из текущего состава варианта товара. */
export function UpdateCompositionButton({ itemId }: { itemId: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => start(async () => { await ownerUpdateOrderItemComposition(itemId); setDone(true); setTimeout(() => setDone(false), 1500); })}
      disabled={pending}
      className="mt-1 text-xs text-sky-600 hover:text-sky-800 disabled:opacity-60"
    >
      {pending ? "Обновление…" : done ? "✓ обновлено" : "Обновить состав из товара"}
    </button>
  );
}
