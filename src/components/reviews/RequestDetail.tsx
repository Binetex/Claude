"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Phone, Send, MapPin, Gift, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { REVIEW_STATUS_BADGE } from "@/lib/reviewStatus";
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
 * Карточка одного запроса отзыва: что было и что делать дальше.
 *
 * Разделение с очередью простое: в очереди — чей ход и одна кнопка, здесь — вся история.
 * Раньше всё это лежало в одной плашке списка, и человек переставал понимать, где он находится.
 *
 * Исход разговора выбирается ОДНИМ списком, а не восемью кнопками: список читается сверху вниз
 * и не заставляет глазами искать нужное среди похожих.
 */
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

type Result = { ok?: true; message?: string; error?: string };

export function RequestDetail({ vm, backHref }: { vm: RequestDetailVM; backHref: string }) {
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
    <div className="mx-auto max-w-3xl space-y-3">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> К очереди
      </Link>

      {/* Шапка: кто, по какому заказу и на каком шаге. */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS_BADGE[vm.status] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}>
            {vm.statusLabel}
          </span>
          {vm.overdue && <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900">просрочено</span>}
          <span className="text-base font-semibold text-slate-900">{vm.order.customerName ?? "без имени"}</span>
          {vm.order.customerPhone && (
            <a href={`tel:${vm.order.customerPhone}`} className="inline-flex items-center gap-1 font-mono text-sm text-sky-700 hover:underline">
              <Phone className="size-3.5" /> {vm.order.customerPhone}
            </a>
          )}
          <span className="ml-auto text-xs text-slate-500">{vm.order.siteName}</span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <Link href={vm.order.href} className="font-mono text-sky-700 hover:underline">{vm.order.number}</Link>
          <span>· {vm.order.items}</span>
          <span>· доставка {vm.order.deliveryLabel}</span>
          {vm.nextActionLabel && <span>· {vm.nextActionLabel}</span>}
          {vm.linkSentLabel && <span>· ссылка отправлена {vm.linkSentLabel}</span>}
        </div>
        {vm.order.address && <div className="mt-1 text-xs text-slate-400">{vm.order.address}</div>}

        <p className="mt-2 text-sm text-slate-700">{vm.guidance}</p>

        {/* Главное, что терялось: человек ответил, а никто не заметил. */}
        {vm.awaitingUs && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-900">
            Клиент ответил последним — ход за вами.
          </p>
        )}
      </div>

      {(note || error) && (
        <p className={`rounded-lg border px-3 py-2 text-sm ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {error ?? note}
        </p>
      )}

      {/* Действия: исход разговора списком, отправки — кнопками. */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value=""
            disabled={pending}
            className="h-9 w-auto text-sm"
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

          <Button size="sm" variant="outline" disabled={pending || !vm.location.url} onClick={() => run(() => sendLinkAction(vm.id))}>
            <Send className="size-4" /> Отправить ссылку
          </Button>

          <Button size="sm" variant={couponSent ? "outline" : "default"} disabled={pending || !vm.coupon.code} onClick={() => run(() => sendCouponAction(vm.id))}>
            <Gift className="size-4" /> {couponSent ? "Отправить купон ещё раз" : "Отправить купон"}
          </Button>
        </div>

        {/* Купон: следующий шаг после обещания, о котором проще всего забыть. */}
        <p className="mt-2 text-xs text-slate-500">
          {vm.coupon.code ? (
            <>
              Купон за отзыв: <span className="font-mono text-slate-800">{vm.coupon.code}</span>
              {couponSent ? (
                <span className="text-emerald-700"> · отправлен {vm.coupon.sentAt}{vm.coupon.sentCode && vm.coupon.sentCode !== vm.coupon.code ? ` (код был ${vm.coupon.sentCode})` : ""}</span>
              ) : (
                <span className="text-amber-700"> · клиенту ещё не отправляли</span>
              )}
            </>
          ) : (
            <>Купон не задан — впишите код в «Отзывы → Сообщения», и его можно будет отправлять отсюда одной кнопкой.</>
          )}
        </p>

        {/* Точка подставлена по индексу — это догадка, а человек говорит с клиентом и знает лучше. */}
        {vm.locations.length > 1 && (
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <MapPin className="size-3.5" />
            <span>Отзыв на точку</span>
            <Select
              value={vm.location.id ?? ""}
              disabled={pending}
              className="h-8 w-auto text-xs"
              onChange={(e) => run(() => changeLocationAction(vm.id, e.target.value))}
            >
              <option value="" disabled>{vm.location.name ?? "не выбрана"}</option>
              {vm.locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* Переписка и звонки: то, чего на экране отзывов не было вовсе. */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <MessageSquare className="size-4 text-slate-400" /> Переписка и звонки
        </h2>
        {vm.thread.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">С этим номером мы ещё не общались.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {vm.thread.map((t) => (
              <li key={t.id} className={`rounded-lg px-2.5 py-1.5 text-sm ${t.inbound ? "bg-sky-50 text-slate-800" : "bg-slate-50 text-slate-700"}`}>
                <span className="text-[11px] text-slate-400">{t.at} · </span>
                <span className="text-[11px] font-medium text-slate-500">{t.inbound ? "клиент" : "мы"} · {t.kind}</span>
                {t.failed && <span className="ml-1 text-[11px] text-red-600">не отправлено</span>}
                {t.photos > 0 && <span className="ml-1 text-[11px] text-slate-500">фото: {t.photos}</span>}
                {t.text && <div className="mt-0.5 whitespace-pre-wrap">{t.text}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Журнал: «звонили трижды за неделю» должно быть видно, а не стёрто последним статусом. */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Что делали по этому запросу</h2>
        {vm.journal.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Пока ничего.</p>
        ) : (
          <ul className="mt-2 space-y-0.5 border-l border-slate-200 pl-3 text-xs">
            {vm.journal.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-[11px] text-slate-400">{e.at}</span>{" "}
                <span className="text-slate-700">{e.label}</span>
                {e.by && <span className="text-slate-400"> · {e.by}</span>}
                {e.detail && <span className="text-slate-400"> · {e.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
