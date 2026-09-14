"use client";
import { useState, useTransition } from "react";
import { setEventMuted } from "./actions";

/**
 * Галочка «отправлять это уведомление». Владелец гасит конкретное сообщение, не трогая весь
 * поток адресата: «новые заказы не нужны, я вижу их в чате флориста», но «нет курьеров на
 * маршрут» приходить обязано.
 *
 * Выключено выше по адресату — галочка ничего не изменит, поэтому она заблокирована: иначе
 * владелец щёлкал бы её и не понимал, почему уведомление всё равно не приходит.
 */
export function EventToggle({ type, muted, audienceOff }: { type: string; muted: boolean; audienceOff: boolean }) {
  const [value, setValue] = useState(!muted);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <label className="flex shrink-0 items-center gap-1" title={audienceOff ? "Выключено целиком для этого адресата" : "Отправлять это уведомление"}>
      <input
        type="checkbox"
        className="h-3.5 w-3.5"
        checked={value}
        disabled={pending || audienceOff}
        onChange={(e) => {
          const next = e.target.checked;
          const prev = value;
          setError(null);
          setValue(next);
          start(async () => {
            const res = await setEventMuted(type, !next);
            if (res.error) {
              setValue(prev);
              setError(res.error);
            }
          });
        }}
      />
      {error && <span className="text-red-600">{error}</span>}
    </label>
  );
}
