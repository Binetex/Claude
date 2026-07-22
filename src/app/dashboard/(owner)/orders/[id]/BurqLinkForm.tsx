"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { linkBurqOrderAction } from "./deliveryActions";

/**
 * Ручная привязка существующего Burq Order (o_...) к заказу. Простая форма без preview-экрана:
 * ввод ID → «Привязать». Если у заказа уже есть активная доставка — сервер вернёт needsConfirm,
 * показываем короткое подтверждение «Заменить текущую доставку?».
 */
export function BurqLinkForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(linkBurqOrderAction, null);
  const [value, setValue] = useState("");
  const needsConfirm = state?.needsConfirm === true;

  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
      <summary className="cursor-pointer font-medium text-slate-600">Привязать существующий Burq Order</summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="orderId" value={orderId} />
        <label className="block text-slate-500" htmlFor="burqOrderId">Burq Order ID</label>
        <input
          id="burqOrderId"
          name="burqOrderId"
          value={value}
          onChange={(e) => setValue(e.target.value.trim())}
          placeholder="o_..."
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs text-slate-800"
        />
        {needsConfirm ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-2">
            <p className="text-amber-800">{state?.message} Заменить текущую доставку?</p>
            <div className="mt-1 flex items-center gap-2">
              <input type="hidden" name="confirm" value="1" />
              <Button type="submit" size="sm" disabled={pending || !value}>{pending ? "Замена…" : "Заменить"}</Button>
            </div>
          </div>
        ) : (
          <Button type="submit" size="sm" disabled={pending || !value}>{pending ? "Привязка…" : "Привязать"}</Button>
        )}
        {state?.error && <p className="text-red-600">{state.error}</p>}
        {state?.ok && <p className="text-emerald-700">{state.message}</p>}
      </form>
    </details>
  );
}
