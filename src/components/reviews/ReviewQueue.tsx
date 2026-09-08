"use client";
import Link from "next/link";
import { REVIEW_STATUS_BADGE } from "@/lib/reviewStatus";

export type CardVM = {
  id: string;
  status: string;
  statusLabel: string;
  /** Статус фразой: «ещё не звонили», «звоним, попытка 2 из 2». */
  statusText: string;
  /** Фото букета — по нему заказ узнают быстрее, чем по номеру. */
  photoUrl: string | null;
  recipientName: string | null;
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

type Tab = "today" | "waiting" | "check" | "done" | "closed";

/**
 * Очередь запросов отзывов. Каждый исход разговора — одна кнопка: оператор говорит с
 * клиентом и не должен в это время выбирать статус из списка или что-то печатать.
 *
 * Кнопки зависят от СОСТОЯНИЯ запроса, а не от вкладки: на карточке «обещал оставить»
 * кнопкам звонка делать нечего, а «на проверке» главное действие — засчитать отзыв.
 */
export function ReviewQueue({ tab, cards }: { tab: Tab; cards: CardVM[] }) {
  if (cards.length === 0) {
    return (
      <div className="space-y-2">
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          {tab === "today"
            ? "На сегодня звонков нет."
            : tab === "waiting"
              ? "Никто не ждёт ответа."
              : tab === "check"
                ? "Проверять нечего."
                : tab === "done"
                  ? "Отзывов пока нет."
                  : "Здесь будут запросы, по которым отзыв получить не удалось."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cards.map((c) => (
        <RequestCard key={c.id} card={c} />
      ))}
    </div>
  );
}

/**
 * Одна строка очереди — целиком ссылка, как карточка магазина в разделе «Магазины».
 *
 * Внутри НЕТ ни одной кнопки, и это главное: кнопки внутри ссылки нельзя нажать, не попав в
 * ссылку, а список из восьми кнопок на карточку владелец справедливо назвал кашей. Отмечают
 * результат на странице запроса — там для этого есть и переписка, и история.
 *
 * Показываем ровно то, по чему запрос узнают и выбирают: фото букета, кому пишем, что за заказ,
 * когда последний раз общались и что происходит сейчас.
 */
function RequestCard({ card }: { card: CardVM }) {
  return (
    <Link
      href={card.detailHref}
      className={`block rounded-xl border transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
        card.repliedLast ? "border-amber-300 bg-amber-50/40" : card.overdue ? "border-amber-200 bg-white" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Обычный <img>, как в других списках: ZoomableImage внутри ссылки-карточки был бы
            вложенной кнопкой и перехватывал бы клик по самой карточке. */}
        {card.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.photoUrl} alt="" className="size-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400">
            без фото
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium text-slate-900">{card.customerName ?? "без имени"}</span>
            {card.customerPhone && <span className="font-mono text-xs text-slate-500">{card.customerPhone}</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {card.orderNumber} · {card.items} · доставка {card.deliveryLabel}
            {card.recipientName ? ` · получатель ${card.recipientName}` : ""}
          </div>

          {/* Когда последний раз общались — и ответ клиента, если ход за нами. */}
          {card.lastContact ? (
            <div className={`mt-1 truncate text-xs ${card.repliedLast ? "text-amber-900" : "text-slate-500"}`}>
              {card.repliedLast && <span className="font-semibold">Клиент ответил · </span>}
              {card.lastContact.at} · {card.lastContact.who}
              {card.lastContact.text ? `: ${card.lastContact.text}` : ""}
            </div>
          ) : (
            <div className="mt-1 text-xs text-slate-400">Ещё не общались</div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded-md border px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS_BADGE[card.status] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}
          >
            {card.statusText}
          </span>
          {card.overdue && <span className="text-[11px] text-amber-800">просрочено</span>}
          <span className="text-[11px] text-slate-400">{card.siteName}</span>
        </div>
      </div>
    </Link>
  );
}
