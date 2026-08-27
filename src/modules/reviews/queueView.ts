import "server-only";
/**
 * Сборка данных для экрана очереди. Один код на два экрана — очередь оператора и её вкладку у
 * владельца: списки, счётчики и подписи обязаны совпадать, иначе двое смотрят на «одну» очередь
 * и видят разное.
 */
import { format } from "date-fns";
import { prisma } from "@/lib/db";
import { listToday, listWaiting, listToCheck, listClosed, queueCounts, type QueueCard } from "./queue";
import { resolveReviewSettings } from "./requests";
import { REVIEW_STATUS_LABELS } from "@/lib/reviewStatus";
import type { CardVM } from "@/components/reviews/ReviewQueue";

export type QueueTab = "today" | "waiting" | "check" | "closed";
export const QUEUE_TABS: QueueTab[] = ["today", "waiting", "check", "closed"];

export function parseQueueTab(raw: string | undefined): QueueTab {
  return QUEUE_TABS.includes(raw as QueueTab) ? (raw as QueueTab) : "today";
}

export type QueueScreenData = {
  cards: CardVM[];
  counts: { today: number; waiting: number; toCheck: number };
  locationsBySite: Record<string, { id: string; name: string }[]>;
};

/** `orderHref` строит вызывающий: у оператора своя карточка заказа, у владельца своя. */
export async function loadQueueScreen(tab: QueueTab, orderHref: (orderId: string) => string): Promise<QueueScreenData> {
  const [cards, counts] = await Promise.all([
    tab === "today" ? listToday() : tab === "waiting" ? listWaiting() : tab === "check" ? listToCheck() : listClosed(),
    queueCounts(),
  ]);

  // Точки нужны для смены вручную. Раскладываем ПО МАГАЗИНАМ: общий список предлагал бы точки
  // чужого магазина, а сервер их всё равно отвергает.
  const siteIds = [...new Set(cards.map((c) => c.order.site.id))];
  const allLocations = await prisma.googleLocation.findMany({
    where: { siteId: { in: siteIds }, isActive: true },
    select: { id: true, name: true, siteId: true },
    orderBy: { name: "asc" },
  });
  const locationsBySite: Record<string, { id: string; name: string }[]> = {};
  for (const l of allLocations) {
    (locationsBySite[l.siteId] ??= []).push({ id: l.id, name: l.name });
  }

  const settingsBySite = new Map(
    await Promise.all(siteIds.map(async (id) => [id, await resolveReviewSettings(prisma, id)] as const))
  );

  const now = new Date();
  return {
    counts,
    locationsBySite,
    cards: cards.map((c) => toVM(c, now, settingsBySite.get(c.order.site.id)?.maxCallAttempts ?? 2, orderHref)),
  };
}

function toVM(c: QueueCard, now: Date, maxAttempts: number, orderHref: (orderId: string) => string): CardVM {
  const items = c.order.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ");
  const next = c.nextActionAt;
  return {
    id: c.id,
    status: c.status,
    statusLabel: REVIEW_STATUS_LABELS[c.status],
    callAttempts: c.callAttempts,
    maxAttempts,
    // У «обещал оставить» срок означает «пора напомнить», и занимается этим система. Показывать
    // там «вернуться» и «просрочено» значит намекать человеку, что он что-то проспал.
    nextActionLabel: next && operatorTurn(c.status) ? `вернуться ${format(next, "dd.MM")}` : null,
    overdue: !!next && operatorTurn(c.status) && next.getTime() < startOfToday(now).getTime(),
    siteId: c.order.site.id,
    locationId: c.location?.id ?? null,
    locationName: c.location?.name ?? null,
    hasLink: !!c.reviewUrlSnapshot,
    linkChannelLabel: c.linkChannel === "SMS" ? "в SMS" : c.linkChannel === "EMAIL" ? "письмом" : null,
    orderId: c.order.id,
    orderHref: orderHref(c.order.id),
    orderNumber: c.order.orderNumber,
    siteName: c.order.site.name,
    customerName: c.order.senderName,
    customerPhone: c.order.senderPhone,
    items: items || "без позиций",
    deliveryLabel: format(c.order.deliveryDate, "dd.MM"),
  };
}

/** Ход за человеком: только в этих шагах он что-то должен сделать сам. */
function operatorTurn(status: string): boolean {
  return status === "NEW" || status === "CALLING";
}

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
