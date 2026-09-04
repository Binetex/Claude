"use client";
import { useState, useTransition } from "react";
import { setOrderAssistantDisabledAction } from "./assistantActions";

/** Галочка «без ИИ» по заказу. Показывается сразу, при отказе сервера возвращается назад. */
export function AssistantOrderToggle({ orderId, disabled }: { orderId: string; disabled: boolean }) {
  const [value, setValue] = useState(disabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <label className="flex items-center gap-1.5 text-xs font-normal text-slate-600">
      <input
        type="checkbox"
        className="h-3.5 w-3.5"
        checked={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          const prev = value;
          setError(null);
          setValue(next);
          start(async () => {
            const res = await setOrderAssistantDisabledAction(orderId, next);
            if (res.error) {
              setValue(prev);
              setError(res.error);
            }
          });
        }}
      />
      без ИИ по этому заказу
      {error && <span className="text-red-600">{error}</span>}
    </label>
  );
}
