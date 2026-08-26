"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Phone, Send, Check, X, RotateCcw, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
} from "./actions";

export type CardVM = {
  id: string;
  status: string;
  statusLabel: string;
  callAttempts: number;
  maxAttempts: number;
  nextActionLabel: string | null;
  overdue: boolean;
  locationName: string | null;
  hasLink: boolean;
  linkChannelLabel: string | null;
  orderId: string;
  orderNumber: string;
  siteName: string;
  customerName: string | null;
  customerPhone: string | null;
  items: string;
  deliveryLabel: string;
};

type Tab = "today" | "waiting" | "check" | "closed";

/**
 * Очередь оператора. Каждый исход — одна кнопка: оператор говорит с клиентом и не должен в это
 * время выбирать статус из списка или что-то печатать.
 */
export function ReviewQueue({
  tab,
  cards,
  locations,
}: {
  tab: Tab;
  cards: CardVM[];
  locations: { id: string; name: string }[];
}) {
  // Сообщение живёт НАД списком, а не в карточке: после отметки карточка уходит из вкладки
  // вместе с ответом, и оператор не узнал бы, ушла ли ссылка при исчерпании попыток.
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const banner = (note || error) && (
    <p className={`rounded-lg border px-3 py-2 text-sm ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
      {error ?? note}
    </p>
  );

  if (cards.length === 0) {
    return (
      <div className="space-y-2">
        {banner}
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          {tab === "today"
          ? "На сегодня звонков нет."
          : tab === "waiting"
            ? "Никто не ждёт ответа."
            : tab === "check"
              ? "Проверять нечего."
                : "Закрытых запросов пока нет."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {banner}
      {cards.map((c) => (
        <RequestCard key={c.id} card={c} tab={tab} locations={locations} onResult={{ setNote, setError }} />
      ))}
    </div>
  );
}

function RequestCard({
  card,
  tab,
  locations,
  onResult,
}: {
  card: CardVM;
  tab: Tab;
  locations: { id: string; name: string }[];
  onResult: { setNote: (v: string | null) => void; setError: (v: string | null) => void };
}) {
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    onResult.setNote(null);
    onResult.setError(null);
    start(async () => {
      const res = await fn();
      if (res.error) onResult.setError(`${card.orderNumber}: ${res.error}`);
      else if (res.message) onResult.setNote(`${card.orderNumber}: ${res.message}`);
    });
  }

  return (
    <div
      className={`rounded-xl border bg-white px-4 py-3 ${card.overdue ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Link href={`/dashboard/cc/${card.orderId}`} className="font-mono text-xs font-medium text-sky-700 hover:underline">
          {card.orderNumber}
        </Link>
        <span className="text-slate-800">{card.customerName ?? "без имени"}</span>
        {card.customerPhone && (
          <a href={`tel:${card.customerPhone}`} className="font-mono text-xs text-slate-600 hover:underline">
            {card.customerPhone}
          </a>
        )}
        <span className="rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600">{card.statusLabel}</span>
        {card.overdue && <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900">просрочено</span>}
        <span className="ml-auto text-xs text-slate-500">{card.siteName}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{card.items}</span>
        <span>· доставка {card.deliveryLabel}</span>
        {card.nextActionLabel && <span>· {card.nextActionLabel}</span>}
        {card.callAttempts > 0 && (
          <span>
            · попытка {card.callAttempts} из {card.maxAttempts}
          </span>
        )}
        {card.linkChannelLabel && <span>· ссылка ушла {card.linkChannelLabel}</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {tab !== "closed" ? (
          <>
            {(tab === "today" || tab === "waiting") && (
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => noAnswerAction(card.id))}>
                  <Phone className="size-4" /> Не дозвонилась
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => talkedAction(card.id))}>
                  Поговорили
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => promisedAction(card.id))}>
                  Обещал оставить
                </Button>
                {/* Ссылку слать некуда, пока у магазина нет ни точки, ни запасной. */}
                <Button size="sm" disabled={pending || !card.hasLink} onClick={() => run(() => sendLinkAction(card.id))}>
                  <Send className="size-4" /> Отправить ссылку
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => claimedAction(card.id))}>
              Сказал, что оставил
            </Button>
            {tab === "check" && (
              <Button size="sm" disabled={pending} onClick={() => run(() => confirmAction(card.id))}>
                <Check className="size-4" /> Засчитать отзыв
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => declineAction(card.id))} className="text-slate-500">
              <X className="size-4" /> Отказался
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => giveUpAction(card.id))} className="text-slate-500">
              Не удалось
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reopenAction(card.id))}>
            <RotateCcw className="size-4" /> Вернуть в работу
          </Button>
        )}
      </div>

      {/* Точка подставлена по ZIP — это догадка, а оператор говорит с клиентом и знает лучше. */}
      {tab !== "closed" && locations.length > 1 && (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          <MapPin className="size-3.5" />
          <span>Отзыв на точку</span>
          <Select
            value={locations.find((l) => l.name === card.locationName)?.id ?? ""}
            disabled={pending}
            onChange={(e) => run(() => changeLocationAction(card.id, e.target.value))}
            className="h-7 w-auto text-xs"
          >
            <option value="" disabled>
              {card.locationName ?? "не выбрана"}
            </option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      )}

    </div>
  );
}
