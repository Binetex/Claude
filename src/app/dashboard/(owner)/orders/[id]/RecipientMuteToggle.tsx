"use client";
import { useState, useTransition } from "react";
import { setOrderRecipientMutedAction, setRecipientQuietAction } from "./recipientMuteActions";

/**
 * «Сюрприз: получателю не пишем» — галочка в блоке «Общение».
 *
 * Стоит именно здесь, а не в карточке заказа: решение принимают в тот момент, когда смотрят на
 * вкладку «Получатель» и собираются ему написать. Значение применяется сразу, при отказе
 * сервера возвращается назад.
 */
export function RecipientMuteToggle({ orderId, muted, quiet = false }: { orderId: string; muted: boolean; quiet?: boolean }) {
  const [value, setValue] = useState(muted);
  const [never, setNever] = useState(quiet);
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
      {/* По номеру и навсегда: получательница всегда на месте, а вопросы и «не можем связаться»
          заказчику ей и ему только мешают (владелец 12.10.2026). */}
      <label className="flex items-center gap-1.5 text-xs font-normal text-slate-600">
        <input
          type="checkbox"
          className="h-3.5 w-3.5"
          checked={never}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            const prev = never;
            setError(null);
            setNever(next);
            start(async () => {
              const res = await setRecipientQuietAction(orderId, next);
              if (res.error) {
                setNever(prev);
                setError(res.error);
              }
            });
          }}
        />
        этому получателю не писать никогда
      </label>
      {never && (
        <span className="text-xs text-amber-700">
          Во всех заказах на этот номер: ни автосообщений ей, ни «не можем связаться» заказчику.
        </span>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
