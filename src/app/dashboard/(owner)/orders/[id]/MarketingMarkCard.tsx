"use client";
import { useState, useTransition } from "react";
import { MessageSquareOff } from "lucide-react";
import type { OrderMarketingMark } from "@/generated/prisma/enums";
import { MARKETING_MARK_META } from "@/lib/marketingMark";
import { setOrderMarketingMarkAction } from "./marketingActions";

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
export function MarketingMarkCard({ orderId, mark }: { orderId: string; mark: OrderMarketingMark | null }) {
  const [value, setValue] = useState<OrderMarketingMark | null>(mark);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
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
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </details>
  );
}
