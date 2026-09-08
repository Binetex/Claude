"use client";
import { useState, useTransition } from "react";
import { Send, Gift, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { RequestDetailVM } from "@/modules/reviews/requestView";
import {
  noAnswerAction,
  talkedAction,
  promisedAction,
  claimedAction,
  confirmAction,
  declineAction,
  giveUpAction,
  reopenAction,
  sendLinkAction,
  changeLocationAction,
  sendCouponAction,
} from "@/modules/reviews/queueActions";

/**
 * Правая колонка страницы запроса — ровно как «Статус заказа» и «Быстрые действия» в карточке
 * заказа: там человек и ищет управление, потому что так устроен весь дашборд.
 *
 * Исход разговора — одним списком, а не восемью кнопками: список читается сверху вниз, а восемь
 * одинаковых кнопок владелец справедливо назвал кашей.
 */
type Result = { ok?: true; message?: string; error?: string };

const OUTCOMES: { value: string; label: string; run: (id: string) => Promise<Result> }[] = [
  { value: "no_answer", label: "Не дозвонились", run: noAnswerAction },
  { value: "talked", label: "Поговорили", run: talkedAction },
  { value: "promised", label: "Обещал оставить отзыв", run: promisedAction },
  { value: "claimed", label: "Сказал, что оставил", run: claimedAction },
  { value: "confirm", label: "Засчитать отзыв", run: confirmAction },
  { value: "decline", label: "Отказался", run: declineAction },
  { value: "give_up", label: "Не удалось", run: giveUpAction },
  { value: "reopen", label: "Вернуть в работу", run: reopenAction },
];

export function RequestActions({ vm }: { vm: RequestDetailVM }) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<Result>) {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.error) setError(res.error);
      else if (res.message) setNote(res.message);
    });
  }

  const couponSent = !!vm.coupon.sentAt;

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Статус запроса</h2>
        <p className="mt-1 text-sm text-slate-700">{vm.statusText}</p>
        <p className="mt-1 text-xs text-slate-500">{vm.guidance}</p>

        <Select
          value=""
          disabled={pending}
          className="mt-2 h-9 w-full text-sm"
          onChange={(e) => {
            const o = OUTCOMES.find((x) => x.value === e.target.value);
            if (o) run(() => o.run(vm.id));
          }}
        >
          <option value="" disabled>Отметить результат…</option>
          {OUTCOMES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>

        {(note || error) && (
          <p className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
            {error ?? note}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Быстрые действия</h2>
        <div className="mt-2 space-y-2">
          <Button size="sm" variant="outline" className="w-full" disabled={pending || !vm.location.url} onClick={() => run(() => sendLinkAction(vm.id))}>
            <Send className="size-4" /> Отправить ссылку на отзыв
          </Button>
          <Button size="sm" variant={couponSent ? "outline" : "default"} className="w-full" disabled={pending || !vm.coupon.code} onClick={() => run(() => sendCouponAction(vm.id))}>
            <Gift className="size-4" /> {couponSent ? "Отправить купон ещё раз" : "Отправить купон"}
          </Button>
        </div>

        {/* Купон — следующий шаг после обещания, о котором проще всего забыть. */}
        <p className="mt-2 text-xs text-slate-500">
          {vm.coupon.code ? (
            <>
              Купон: <span className="font-mono text-slate-800">{vm.coupon.code}</span>
              {couponSent ? (
                <span className="text-emerald-700"> · отправлен {vm.coupon.sentAt}</span>
              ) : (
                <span className="text-amber-700"> · ещё не отправляли</span>
              )}
            </>
          ) : (
            <>Купон не задан — впишите код в «Отзывы → Сообщения».</>
          )}
        </p>
      </section>

      {vm.locations.length > 1 && (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <MapPin className="size-4 text-slate-400" /> Отзыв на точку
          </h2>
          {/* Точка подставлена по индексу — это догадка, а человек говорит с клиентом и знает лучше. */}
          <Select
            value={vm.location.id ?? ""}
            disabled={pending}
            className="mt-2 h-9 w-full text-sm"
            onChange={(e) => run(() => changeLocationAction(vm.id, e.target.value))}
          >
            <option value="" disabled>{vm.location.name ?? "не выбрана"}</option>
            {vm.locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </section>
      )}
    </div>
  );
}
