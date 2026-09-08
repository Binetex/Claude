"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Phone, Send, Check, RotateCcw, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REVIEW_STATUS_BADGE } from "@/lib/reviewStatus";
import {
  noAnswerAction,
  talkedAction,
  promisedAction,
  claimedAction,
  confirmAction,
  reopenAction,
  sendLinkAction,
} from "@/modules/reviews/queueActions";

export type CardVM = {
  id: string;
  status: string;
  statusLabel: string;
  callAttempts: number;
  maxAttempts: number;
  nextActionLabel: string | null;
  overdue: boolean;
  siteId: string;
  locationId: string | null;
  locationName: string | null;
  hasLink: boolean;
  linkChannelLabel: string | null;
  orderId: string;
  /** Куда ведёт номер заказа: у оператора своя карточка, у владельца своя. */
  orderHref: string;
  /** Куда ведёт сам запрос: карточка со всей историей, перепиской и купоном. */
  detailHref: string;
  /** Последним в разговоре высказался клиент — ход за нами. */
  repliedLast: boolean;
  orderNumber: string;
  siteName: string;
  customerName: string | null;
  customerPhone: string | null;
  items: string;
  deliveryLabel: string;
  /** Журнал запроса, старые сверху: когда кто связывался и что было сделано. */
  journal: { at: string; label: string; by: string | null; detail: string | null }[];
  /** Последнее общение с этим номером: звонок, расшифровка или сообщение. */
  lastContact: { at: string; who: string; inbound: boolean; text: string | null } | null;
  /** Что сейчас делать и что нажать — по состоянию запроса. */
  guidance: string;
};

type Tab = "today" | "waiting" | "check" | "closed";

const CLOSED_STATUSES = new Set(["CONFIRMED", "DECLINED", "GAVE_UP"]);
const CALL_STATUSES = new Set(["NEW", "CALLING"]);

/**
 * Очередь запросов отзывов. Каждый исход разговора — одна кнопка: оператор говорит с
 * клиентом и не должен в это время выбирать статус из списка или что-то печатать.
 *
 * Кнопки зависят от СОСТОЯНИЯ запроса, а не от вкладки: на карточке «обещал оставить»
 * кнопкам звонка делать нечего, а «на проверке» главное действие — засчитать отзыв.
 */
export function ReviewQueue({ tab, cards }: { tab: Tab; cards: CardVM[] }) {
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
        <RequestCard key={c.id} card={c} onResult={{ setNote, setError }} />
      ))}
    </div>
  );
}

function RequestCard({
  card,
  onResult,
}: {
  card: CardVM;
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

  const closed = CLOSED_STATUSES.has(card.status);
  const calling = CALL_STATUSES.has(card.status);
  const waitingClient = card.status === "LINK_SENT" || card.status === "PROMISED" || card.status === "FORGOT";

  return (
    <div
      className={`rounded-xl border bg-white px-4 py-3 ${card.overdue ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span
          className={`rounded-md border px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS_BADGE[card.status] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}
        >
          {card.statusLabel}
        </span>
        {card.overdue && <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900">просрочено</span>}
        <Link href={card.orderHref} className="font-mono text-xs font-medium text-sky-700 hover:underline">
          {card.orderNumber}
        </Link>
        <span className="text-slate-800">{card.customerName ?? "без имени"}</span>
        {card.customerPhone && (
          <a href={`tel:${card.customerPhone}`} className="font-mono text-xs text-slate-600 hover:underline">
            {card.customerPhone}
          </a>
        )}
        <span className="ml-auto text-xs text-slate-500">{card.siteName}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{card.items}</span>
        <span>· доставка {card.deliveryLabel}</span>
        {card.nextActionLabel && <span>· {card.nextActionLabel}</span>}
        {card.linkChannelLabel && <span>· ссылка ушла {card.linkChannelLabel}</span>}
      </div>

      {/* Что с этим человеком уже было. Без этой строки карточка выглядела одинаково и у того,
          кто вчера всё сказал по телефону, и у того, с кем не общались ни разу.
          Ответ КЛИЕНТА выделен: именно он терялся — человек писал «да, оставлю», и это пропадало. */}
      {card.lastContact && (
        <p
          className={`mt-1.5 rounded-md px-2 py-1.5 text-xs ${
            card.repliedLast ? "border border-amber-300 bg-amber-50 text-amber-900" : "bg-slate-50 text-slate-600"
          }`}
        >
          {card.repliedLast && <span className="mr-1 font-semibold">Клиент ответил — ход за вами.</span>}
          <span className={card.repliedLast ? "text-amber-700" : "text-slate-400"}>{card.lastContact.at} · </span>
          <span className="font-medium">{card.lastContact.who}</span>
          {card.lastContact.text ? <>: {card.lastContact.text}</> : <span className="opacity-60"> · без текста</span>}
        </p>
      )}

      {/* Ответ на «что нужно помечать и как»: карточка сама говорит, чей ход и что нажать. */}
      {card.guidance && <p className="mt-2 text-xs text-slate-600">{card.guidance}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {closed ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reopenAction(card.id))}>
            <RotateCcw className="size-4" /> Вернуть в работу
          </Button>
        ) : (
          <>
            {calling && (
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => noAnswerAction(card.id))}>
                  <Phone className="size-4" /> Не дозвонились
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
            {waitingClient && (
              <Button size="sm" disabled={pending} onClick={() => run(() => claimedAction(card.id))}>
                <Check className="size-4" /> Сказал, что оставил
              </Button>
            )}
            {card.status === "READY_TO_CHECK" && (
              <Button size="sm" disabled={pending} onClick={() => run(() => confirmAction(card.id))}>
                <Check className="size-4" /> Засчитать отзыв
              </Button>
            )}
          </>
        )}

        {/* Всё остальное — переписка, звонки, журнал, купон, точка, «отказался» — на карточке
            запроса. В списке им не место: из-за них он и превратился в кашу. */}
        <Link
          href={card.detailHref}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
        >
          Открыть <ChevronRight className="size-3.5" />
        </Link>
      </div>

    </div>
  );
}
