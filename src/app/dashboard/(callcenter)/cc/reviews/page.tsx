import { requireUser } from "@/lib/rbac";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { prisma } from "@/lib/db";
import { listToday, listWaiting, listToCheck, listClosed, queueCounts, type QueueCard } from "@/modules/reviews/queue";
import { resolveReviewSettings } from "@/modules/reviews/requests";
import { REVIEW_STATUS_LABELS } from "@/lib/reviewStatus";
import { ReviewQueue, type CardVM } from "./ReviewQueue";
import { QueueTabs } from "./QueueTabs";

export const dynamic = "force-dynamic";

type Tab = "today" | "waiting" | "check" | "closed";
const TABS: Tab[] = ["today", "waiting", "check", "closed"];

/**
 * Очередь отзывов колл-центра.
 *
 * Вкладки — это не статусы, а состояния работы: «сегодня» собирается по СРОКУ и потому
 * смешивает новые запросы с недозвонами, «ждут» — там, где ход за клиентом.
 */
export default async function ReviewsQueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (user.role === "FLORIST") notFound();

  const sp = await searchParams;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "today";

  const [cards, counts] = await Promise.all([
    tab === "today" ? listToday() : tab === "waiting" ? listWaiting() : tab === "check" ? listToCheck() : listClosed(),
    queueCounts(),
  ]);

  // Точки нужны для смены вручную. Магазинов в выдаче обычно один-два, поэтому берём разом —
  // но раскладываем ПО МАГАЗИНАМ: общий список предлагал бы оператору точки чужого магазина,
  // а сервер их всё равно отвергает.
  const siteIds = [...new Set(cards.map((c) => c.order.site.id))];
  const allLocations = await prisma.googleLocation.findMany({
    where: { siteId: { in: siteIds }, isActive: true },
    select: { id: true, name: true, siteId: true },
    orderBy: { name: "asc" },
  });
  const locationsBySite = new Map<string, { id: string; name: string }[]>();
  for (const l of allLocations) {
    const list = locationsBySite.get(l.siteId) ?? [];
    list.push({ id: l.id, name: l.name });
    locationsBySite.set(l.siteId, list);
  }

  const settingsBySite = new Map(
    await Promise.all(siteIds.map(async (id) => [id, await resolveReviewSettings(prisma, id)] as const))
  );

  const now = new Date();
  const vms: CardVM[] = cards.map((c) => toVM(c, now, settingsBySite.get(c.order.site.id)?.maxCallAttempts ?? 2));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Отзывы</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Заказы, по которым владелец попросил взять отзыв. Отметьте, чем закончился разговор, — остальное
          система сделает сама.
        </p>
      </div>
      <QueueTabs active={tab} counts={counts} />
      <ReviewQueue tab={tab} cards={vms} locationsBySite={Object.fromEntries(locationsBySite)} />
    </div>
  );
}

function toVM(c: QueueCard, now: Date, maxAttempts: number): CardVM {
  const items = c.order.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ");
  const next = c.nextActionAt;
  return {
    id: c.id,
    status: c.status,
    statusLabel: REVIEW_STATUS_LABELS[c.status],
    callAttempts: c.callAttempts,
    maxAttempts,
    // У «обещал оставить» срок означает «пора напомнить», и занимается этим система. Показывать
    // там «вернуться» и «просрочено» значит намекать оператору, что он что-то проспал.
    nextActionLabel: next && operatorTurn(c.status) ? `вернуться ${format(next, "dd.MM")}` : null,
    // Просрочка — не про «выбыл», а про «пора было вчера». Только там, где ход за оператором.
    overdue: !!next && operatorTurn(c.status) && next.getTime() < startOfToday(now).getTime(),
    siteId: c.order.site.id,
    locationId: c.location?.id ?? null,
    locationName: c.location?.name ?? null,
    hasLink: !!c.reviewUrlSnapshot,
    linkChannelLabel: c.linkChannel === "SMS" ? "в SMS" : c.linkChannel === "EMAIL" ? "письмом" : null,
    orderId: c.order.id,
    orderNumber: c.order.orderNumber,
    siteName: c.order.site.name,
    customerName: c.order.senderName,
    customerPhone: c.order.senderPhone,
    items: items || "без позиций",
    deliveryLabel: format(c.order.deliveryDate, "dd.MM"),
  };
}

/** Ход за оператором: только в этих шагах он что-то должен сделать сам. */
function operatorTurn(status: string): boolean {
  return status === "NEW" || status === "CALLING";
}

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
