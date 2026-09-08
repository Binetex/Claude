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
import { REVIEW_STATUS_LABELS, REVIEW_EVENT_LABELS, reviewStatusText } from "@/lib/reviewStatus";
import { getOrderItemImages } from "@/modules/orders/images";
import type { OrderItemView } from "@/components/orders/OrderItemsCard";
import type { CommunicationCardItem } from "@/integrations/quo/communicationsService";
import { loadPhoneCommunicationsCard } from "@/integrations/quo/communicationsService";
import { loadOrderEmailPanel } from "@/integrations/emailFactory/read";
import { loadReviewReward } from "./reward";

export type RequestDetailVM = {
  id: string;
  status: string;
  statusLabel: string;
  /** Статус фразой: первое, что спрашивают, — «а что с ним сейчас». */
  statusText: string;
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
    items: OrderItemView[];
    deliveryDate: string;
    deliveryLabel: string;
    address: string | null;
    /** Телефон получателя нужен блоку общения: у него вкладки по сторонам заказа. */
    recipientPhone: string;
    recipientName: string;
    photoUrl: string | null;
  };
  location: { id: string | null; name: string | null; url: string | null };
  locations: { id: string; name: string }[];
  linkSentLabel: string | null;
  journal: { at: string; label: string; by: string | null; detail: string | null }[];
  /** Переписка и звонки по номеру заказчика — для общего блока «Общение». */
  comm: { communications: CommunicationCardItem[]; storeHasQuoNumber: boolean; storeTimeZone: string | undefined };
  emails: Awaited<ReturnType<typeof loadOrderEmailPanel>>;
  coupon: { code: string; sentAt: string | null; sentCode: string | null };
};

/**
 * Ход за нами: последним в разговоре высказался клиент, а не мы. Лента приходит НОВЫМИ СВЕРХУ,
 * как её отдаёт общий загрузчик, поэтому смотрим на первый элемент.
 */
export function awaitingUs(newestFirst: { direction: string }[]): boolean {
  return newestFirst[0]?.direction === "INBOUND";
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
          deliveryDate: true, addressLine: true, apartment: true, city: true, zip: true,
          recipientName: true, recipientPhone: true,
          site: { select: { id: true, name: true } },
          items: { select: { name: true, quantity: true, image: true, parentImageUrl: true, variantImageUrl: true } },
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

  // Переписка по НОМЕРУ заказчика: звонок из QUO приходит без привязки к заказу, а разговор
  // может идти по прошлому заказу того же человека.
  const phoneE164 = toE164(r.order.senderPhone);
  const [comm, emails] = await Promise.all([
    phoneE164
      ? loadPhoneCommunicationsCard(prisma, { phoneE164, siteId: r.order.site.id })
      : Promise.resolve({ communications: [], storeHasQuoNumber: false, storeTimeZone: undefined }),
    loadOrderEmailPanel(prisma, r.order.id).catch(() => ({ emails: [], customerEmail: null })),
  ]);
  const maxAttempts = settings?.maxCallAttempts ?? 2;
  // Тот же набор, что в очереди (`queueView::operatorTurn`): ответ клиента — наш ход, и
  // «просрочено» обязано читаться одинаково в списке и в самой карточке.
  const operatorTurn = r.status === "NEW" || r.status === "CALLING" || r.status === "REPLIED";

  return {
    id: r.id,
    status: r.status,
    statusLabel: REVIEW_STATUS_LABELS[r.status] ?? r.status,
    statusText: reviewStatusText(r.status, r.callAttempts, maxAttempts),
    guidance: guidanceFor(r.status, r.callAttempts, maxAttempts),
    callAttempts: r.callAttempts,
    maxAttempts,
    overdue: !!r.nextActionAt && operatorTurn && r.nextActionAt.getTime() < startOfToday().getTime(),
    nextActionLabel: r.nextActionAt && operatorTurn ? `вернуться ${format(r.nextActionAt, "dd.MM")}` : null,
    awaitingUs: awaitingUs(comm.communications),
    order: {
      id: r.order.id,
      href: orderHref(r.order.id),
      number: r.order.orderNumber,
      siteId: r.order.site.id,
      siteName: r.order.site.name,
      customerName: r.order.senderName,
      customerPhone: r.order.senderPhone,
      customerEmail: r.order.senderEmail,
      items: r.order.items.map((i, idx) => {
        const img = getOrderItemImages(i);
        return { id: `${r.id}-${idx}`, name: i.name, quantity: i.quantity, image: img.primary, variantImage: img.variant };
      }),
      deliveryDate: r.order.deliveryDate.toISOString(),
      deliveryLabel: format(r.order.deliveryDate, "dd.MM.yyyy"),
      address: [r.order.addressLine, r.order.apartment, r.order.city, r.order.zip].filter(Boolean).join(", ") || null,
      recipientPhone: r.order.recipientPhone,
      recipientName: r.order.recipientName,
      photoUrl: r.order.items.map((i) => getOrderItemImages(i).primary).find((u) => !!u) ?? null,
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
    comm,
    emails,
    coupon: {
      code: reward.couponCode,
      sentAt: r.couponSentAt ? format(r.couponSentAt, "dd.MM.yyyy HH:mm") : null,
      sentCode: r.couponCodeSnapshot,
    },
  };
}

/** Подсказка «что сейчас делать». Тот же текст, что в очереди: правда должна быть одна. */
function guidanceFor(status: string, callAttempts: number, maxAttempts: number): string {
  switch (status) {
    case "NEW":
      return "Ход за вами: позвоните клиенту и отметьте, чем кончился разговор.";
    case "CALLING":
      return `Ход за вами: позвоните ещё раз (попыток: ${callAttempts} из ${maxAttempts}). После последней неудачной система сама отправит ссылку.`;
    case "IGNORING":
      return "Клиент молчит больше суток. Позвоните ещё раз или закройте запрос — «Отказался» или «Не удалось».";
    case "REPLIED":
      return "Клиент ответил: прочитайте его сообщение в общении и отметьте, чем кончилось.";
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
