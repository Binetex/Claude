"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import type { OrderMarketingMark } from "@/generated/prisma/enums";
import { MARKETING_MARK_META } from "@/lib/marketingMark";
import { setOrderMarketingMarkAction, askRecipientReviewAction } from "./marketingActions";

const OPTIONS: { value: OrderMarketingMark | null; title: string; hint: string }[] = [
  { value: null, title: "Обычный заказ", hint: "Рассылки идут как настроено." },
  {
    value: "MUTED",
    title: MARKETING_MARK_META.MUTED.label,
    hint: "Маркетинговые цепочки клиенту не уйдут — ни будущие, ни те, что уже ждут отправки.",
  },
  {
    value: "ASK_REVIEW",
    title: MARKETING_MARK_META.ASK_REVIEW.label,
    hint: "Колл-центру придёт задача в Telegram: связаться с заказчиком и попросить отзыв.",
  },
];

/**
 * Пометка о работе с клиентом — редкая настройка, поэтому свёрнута и не занимает места в
 * колонке управления. Когда пометка стоит, это видно и в свёрнутом виде: иначе владелец,
 * пролистывая карточку, не узнал бы, что по заказу что-то решено.
 *
 * Варианты взаимоисключающие, поэтому это радио, а не два переключателя: нельзя одновременно
 * молчать и просить отзыв.
 */
export function MarketingMarkCard({
  orderId,
  mark,
  canAskRecipient,
  recipientReview,
}: {
  orderId: string;
  mark: OrderMarketingMark | null;
  /** У получателя свой номер — у него можно попросить отзыв отдельно от заказчика. */
  canAskRecipient: boolean;
  /** Запрос отзыва у получателя, если уже есть: ссылка на него в очереди и его статус. */
  recipientReview: { href: string; label: string } | null;
}) {
  const [value, setValue] = useState<OrderMarketingMark | null>(mark);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [askedHref, setAskedHref] = useState<string | null>(null);

  function askRecipient() {
    setError(null);
    start(async () => {
      const res = await askRecipientReviewAction(orderId);
      if (res.error) setError(res.error);
      else if (res.href) setAskedHref(res.href);
    });
  }
  const review = recipientReview ?? (askedHref ? { href: askedHref, label: "новый" } : null);
  const meta = value ? MARKETING_MARK_META[value] : null;

  function choose(next: OrderMarketingMark | null) {
    if (next === value) return;
    const prev = value;
    setError(null);
    // Показываем выбор сразу, а при отказе сервера возвращаем как было: иначе пометка
    // осталась бы стоять на экране, а цепочки продолжали работать по-старому.
    setValue(next);
    start(async () => {
      const res = await setOrderMarketingMarkAction(orderId, next);
      if (res.error) {
        setValue(prev);
        setError(res.error);
      }
    });
  }

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-slate-500 hover:text-slate-700">
        <MessageSquareOff className="h-3.5 w-3.5" />
        <span>Работа с клиентом</span>
        {meta && <span className={`rounded px-1.5 py-px text-[11px] ${meta.className}`}>{meta.short}</span>}
        {review && <span className="rounded bg-violet-100 px-1.5 py-px text-[11px] text-violet-800">отзыв получателя</span>}
      </summary>

      <div className="mt-3 space-y-2.5">
        {OPTIONS.map((o) => (
          <label key={o.title} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name={`marketing-mark-${orderId}`}
              checked={value === o.value}
              disabled={pending}
              onChange={() => choose(o.value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-slate-700"
            />
            <span className="text-slate-700">
              {o.title}
              <span className="mt-0.5 block text-xs text-slate-500">{o.hint}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-slate-400">
          Служебные сообщения (доставка сегодня, заказ доставлен, трек) идут в любом случае.
        </p>

        {/* Отзыв у получателя — отдельно от пометки: пометка про заказчика, а это изредка и по
            решению владельца (07.10.2026). Дальше — та же очередь «Отзывы», что у заказчика. */}
        <div className="border-t border-slate-100 pt-2.5">
          <div className="text-slate-700">Отзыв у получателя</div>
          {review ? (
            <p className="mt-0.5 text-xs text-slate-500">
              Запрос в очереди «Отзывы» ({review.label}):{" "}
              <Link href={review.href} className="text-sky-700 underline">открыть</Link>
            </p>
          ) : canAskRecipient ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={askRecipient}
                className="mt-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Попросить отзыв у получателя
              </button>
              <span className="mt-1 block text-xs text-slate-500">Колл-центру придёт задача: связаться с получателем букета и попросить отзыв.</span>
            </>
          ) : (
            <p className="mt-0.5 text-xs text-slate-400">У получателя нет своего номера — просить не у кого.</p>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </details>
  );
}
