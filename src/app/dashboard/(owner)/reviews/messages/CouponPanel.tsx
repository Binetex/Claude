"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { saveCouponAction } from "./actions";

/**
 * Купон за отзыв — ОДИН на все магазины (решение владельца).
 *
 * Стоит рядом с текстами сообщений, потому что это такое же сообщение клиенту, только следующим
 * шагом: человек обещал отзыв — ему уходит вознаграждение. Раньше этот шаг жил в голове, и его
 * пропускали: клиент обещал, купон не получил.
 */
export function CouponPanel({
  initial,
  defaultSms,
}: {
  initial: { couponCode: string; couponSms: string };
  defaultSms: string;
}) {
  const [code, setCode] = useState(initial.couponCode);
  const [sms, setSms] = useState(initial.couponSms);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const dirty = code.trim() !== initial.couponCode.trim() || sms.trim() !== initial.couponSms.trim();

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <h2 className="text-sm font-semibold text-slate-800">Купон за отзыв</h2>
      <p className="mt-1 text-xs text-slate-500">
        Один код на все магазины. Он показывается в карточке запроса, и оттуда же уходит клиенту
        одной кнопкой — чтобы этот шаг не терялся после «клиент обещал оставить отзыв».
      </p>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          <label className="text-xs text-slate-400" htmlFor="coupon-code">Код купона</label>
          <input
            id="coupon-code"
            value={code}
            onChange={(e) => { setCode(e.target.value); setMsg(null); }}
            placeholder="REVIEW20"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400" htmlFor="coupon-sms">Текст SMS клиенту</label>
          <textarea
            id="coupon-sms"
            value={sms}
            onChange={(e) => { setSms(e.target.value); setMsg(null); }}
            rows={3}
            placeholder={defaultSms}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <p className="text-[11px] text-slate-400">
            Пусто — уходит текст по умолчанию (показан в поле). Переменные: {"{{coupon_code}}"}, {"{{store_name}}"},
            {" "}{"{{sender_name}}"}. Только по-английски: это сообщение покупателю.
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              const r = await saveCouponAction({ couponCode: code, couponSms: sms });
              setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: "Сохранено" });
            })
          }
        >
          Сохранить
        </Button>
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>
    </div>
  );
}
