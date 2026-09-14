"use client";
import { useState, useTransition } from "react";
import { setOrderRecipientMutedAction } from "./recipientMuteActions";

/**
 * «Сюрприз: получателю не пишем» — галочка в блоке «Общение».
 *
 * Стоит именно здесь, а не в карточке заказа: решение принимают в тот момент, когда смотрят на
 * вкладку «Получатель» и собираются ему написать. Значение применяется сразу, при отказе
 * сервера возвращается назад.
 */
export function RecipientMuteToggle({ orderId, muted }: { orderId: string; muted: boolean }) {
  const [value, setValue] = useState(muted);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
              const res = await setOrderRecipientMutedAction(orderId, next);
              if (res.error) {
                setValue(prev);
                setError(res.error);
              }
            });
          }}
        />
        сюрприз: получателю не пишем
      </label>
      {value && (
        <span className="text-xs text-amber-700">
          Наши автосообщения получателю молчат, уведомления курьерской службы — нет. Если он
          напишет сам, ответить можно.
        </span>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
