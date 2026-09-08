import "server-only";
/**
 * Данные одной карточки запроса отзыва — то, что открывается по клику из очереди.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. В очереди у запроса должно быть видно одно: чей ход и что нажать.
 * Всё остальное — переписка, звонки, журнал, купон, точка — валилось в ту же плашку, и человек
 * переставал понимать, что вообще происходит (прямая жалоба владельца). Теперь очередь отвечает
 * «что делать», а этот экран — «что было».
 *
 * Переписка берётся ПО НОМЕРУ клиента, а не по заказу: звонок из QUO приходит без привязки к
 * заказу, а разговор может идти по прошлому заказу того же человека. Отдельного «журнала звонков»
 * заводить не надо — звонки и SMS уже лежат в `OrderCommunication`, их кладёт туда приём QUO.
 */
import { format } from "date-fns";
import { prisma } from "@/lib/db";
import { toE164 } from "@/lib/phone";
import { REVIEW_STATUS_LABELS, REVIEW_EVENT_LABELS } from "@/lib/reviewStatus";
import { parseAttachments } from "@/integrations/quo/communicationsService";
import { loadReviewReward } from "./reward";

/** Сколько последних событий переписки показываем: дальше это уже архив, а не контекст. */
const THREAD_LIMIT = 50;

export type ThreadItem = {
  id: string;
  at: string;
  inbound: boolean;
  /** «сообщение», «звонок», «пропущенный звонок», «голосовое». */
  kind: string;
  text: string | null;
  /** Не ушедшее исходящее: человек его не видел, и выглядеть как отправленное оно не должно. */
  failed: boolean;
  photos: number;
};

export type RequestDetailVM = {
  id: string;
  status: string;
  statusLabel: string;
  guidance: string;
  callAttempts: number;
  maxAttempts: number;
  overdue: boolean;
  nextActionLabel: string | null;
  /** Последним в разговоре высказался клиент — ход за нами. */
  awaitingUs: boolean;
  order: {
    id: string;
    href: string;
    number: string;
    siteId: string;
    siteName: string;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    items: string;
    deliveryLabel: string;
    address: string | null;
  };
  location: { id: string | null; name: string | null; url: string | null };
  locations: { id: string; name: string }[];
  linkSentLabel: string | null;
  journal: { at: string; label: string; by: string | null; detail: string | null }[];
  thread: ThreadItem[];
  coupon: { code: string; sentAt: string | null; sentCode: string | null };
};

/** Ход за нами: последним в переписке высказался клиент, а не мы. */
export function awaitingUs(thread: ThreadItem[]): boolean {
  const last = thread[thread.length - 1];
  return !!last?.inbound;
}

export async function loadRequestDetail(
  requestId: string,
  orderHref: (orderId: string) => string
): Promise<RequestDetailVM | null> {
  const r = await prisma.orderReviewRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true, status: true, callAttempts: true, nextActionAt: true, linkSentAt: true, linkChannel: true,
      reviewUrlSnapshot: true, couponSentAt: true, couponCodeSnapshot: true,
      location: { select: { id: true, name: true } },
      order: {
        select: {
          id: true, orderNumber: true, senderName: true, senderPhone: true, senderEmail: true,
          deliveryDate: true, addressLine: true, apartment: true, city: true, zip: true, recipientName: true,
          site: { select: { id: true, name: true } },
          items: { select: { name: true, quantity: true } },
        },
      },
    },
  });
  if (!r) return null;

  const [events, settings, locations, reward] = await Promise.all([
    prisma.reviewRequestEvent.findMany({
      where: { requestId: r.id },
      orderBy: { createdAt: "asc" },
      select: { kind: true, detailSafe: true, createdAt: true, user: { select: { name: true } } },
    }),
    prisma.siteReviewSettings.findUnique({ where: { siteId: r.order.site.id }, select: { maxCallAttempts: true } }),
    prisma.googleLocation.findMany({
      where: { siteId: r.order.site.id, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    loadReviewReward(prisma),
  ]);

  const thread = await loadThread(r.order.senderPhone);
  const maxAttempts = settings?.maxCallAttempts ?? 2;
  const operatorTurn = r.status === "NEW" || r.status === "CALLING";

  return {
    id: r.id,
    status: r.status,
    statusLabel: REVIEW_STATUS_LABELS[r.status] ?? r.status,
    guidance: guidanceFor(r.status, r.callAttempts, maxAttempts),
    callAttempts: r.callAttempts,
    maxAttempts,
    overdue: !!r.nextActionAt && operatorTurn && r.nextActionAt.getTime() < startOfToday().getTime(),
    nextActionLabel: r.nextActionAt && operatorTurn ? `вернуться ${format(r.nextActionAt, "dd.MM")}` : null,
    awaitingUs: awaitingUs(thread),
    order: {
      id: r.order.id,
      href: orderHref(r.order.id),
      number: r.order.orderNumber,
      siteId: r.order.site.id,
      siteName: r.order.site.name,
      customerName: r.order.senderName,
      customerPhone: r.order.senderPhone,
      customerEmail: r.order.senderEmail,
      items: r.order.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ") || "без позиций",
      deliveryLabel: format(r.order.deliveryDate, "dd.MM.yyyy"),
      address: [r.order.addressLine, r.order.apartment, r.order.city, r.order.zip].filter(Boolean).join(", ") || null,
    },
    location: { id: r.location?.id ?? null, name: r.location?.name ?? null, url: r.reviewUrlSnapshot },
    locations,
    linkSentLabel: r.linkSentAt
      ? `${format(r.linkSentAt, "dd.MM HH:mm")}${r.linkChannel === "EMAIL" ? " письмом" : r.linkChannel === "SMS" ? " в SMS" : ""}`
      : null,
    journal: events.map((e) => ({
      at: format(e.createdAt, "dd.MM HH:mm"),
      label: REVIEW_EVENT_LABELS[e.kind] ?? e.kind,
      by: e.user?.name ?? null,
      detail: e.detailSafe,
    })),
    thread,
    coupon: {
      code: reward.couponCode,
      sentAt: r.couponSentAt ? format(r.couponSentAt, "dd.MM.yyyy HH:mm") : null,
      sentCode: r.couponCodeSnapshot,
    },
  };
}

/** Переписка и звонки с этим номером — старые сверху, как в обычном чате. */
async function loadThread(phone: string | null): Promise<ThreadItem[]> {
  const e164 = toE164(phone);
  if (!e164) return [];
  const rows = await prisma.orderCommunication.findMany({
    where: { externalPhoneNormalized: e164 },
    orderBy: { occurredAt: "desc" },
    take: THREAD_LIMIT,
    select: {
      id: true, type: true, direction: true, status: true, messageText: true, transcript: true,
      summary: true, attachmentsJson: true, occurredAt: true, durationSeconds: true,
    },
  });

  return rows
    .map((c) => {
      const inbound = c.direction === "INBOUND";
      const isCall = c.type === "CALL" || c.type === "VOICEMAIL";
      const kind = isCall
        ? c.status === "MISSED"
          ? inbound ? "пропущенный звонок" : "не дозвонились"
          : c.type === "VOICEMAIL" ? "голосовое" : "звонок"
        : "сообщение";
      return {
        id: c.id,
        at: format(c.occurredAt, "dd.MM HH:mm"),
        inbound,
        kind: isCall && c.durationSeconds ? `${kind}, ${Math.round(c.durationSeconds / 60)} мин` : kind,
        text: (c.messageText || c.transcript || c.summary || "").trim() || null,
        failed: !inbound && c.status === "FAILED",
        photos: parseAttachments(c.attachmentsJson).length,
      };
    })
    .reverse();
}

/** Подсказка «что сейчас делать». Тот же текст, что в очереди: правда должна быть одна. */
function guidanceFor(status: string, callAttempts: number, maxAttempts: number): string {
  switch (status) {
    case "NEW":
      return "Ход за вами: позвоните клиенту и отметьте, чем кончился разговор.";
    case "CALLING":
      return `Ход за вами: позвоните ещё раз (попыток: ${callAttempts} из ${maxAttempts}). После последней неудачной система сама отправит ссылку.`;
    case "LINK_SENT":
      return "Ход за клиентом: ссылка у него. Скажет, что оставил, — отметьте «Сказал, что оставил».";
    case "PROMISED":
      return "Ход за клиентом: обещал оставить отзыв. Напоминание уйдёт само.";
    case "FORGOT":
      return "Обещал и забыл: напоминание отправлено.";
    case "READY_TO_CHECK":
      return "Ход за вами: проверьте профиль точки в Google и засчитайте отзыв.";
    case "CONFIRMED":
      return "Отзыв получен. Если купон ещё не ушёл — самое время.";
    case "DECLINED":
      return "Закрыт: клиент отказался.";
    case "GAVE_UP":
      return "Закрыт: получить отзыв не удалось.";
    default:
      return "";
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
