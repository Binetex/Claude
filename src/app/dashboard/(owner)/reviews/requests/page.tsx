import { requireRole } from "@/lib/rbac";
import { getFunnelCounts } from "@/modules/reviews/funnel";
import { loadQueueScreen, parseQueueTab } from "@/modules/reviews/queueView";
import { ReviewQueue } from "@/components/reviews/ReviewQueue";
import { QueueTabs } from "@/components/reviews/QueueTabs";

export const dynamic = "force-dynamic";

const PATH = "/dashboard/reviews/requests";

/**
 * Запросы отзывов у владельца — ОДИН рабочий экран (решение владельца, 2026-08-31):
 * воронка сверху, под ней те же карточки с действиями, что видит колл-центр. Прежняя пара
 * «Запросы — смотреть, Очередь — работать» заставляла искать, где меняется статус.
 */
export default async function ReviewRequestsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireRole("OWNER");

  const tab = parseQueueTab((await searchParams).tab);
  const [funnel, screen] = await Promise.all([
    getFunnelCounts(),
    loadQueueScreen(tab, (id) => `/dashboard/orders/${id}`),
  ]);
  const inWork = funnel.NEW + funnel.CALLING + funnel.LINK_SENT + funnel.PROMISED + funnel.FORGOT + funnel.READY_TO_CHECK;
  const lost = funnel.DECLINED + funnel.GAVE_UP;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Запросы отзывов</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Обычно запросы ведёт колл-центр — но здесь всё то же самое: любой запрос можно
          отметить, закрыть или засчитать самому.
        </p>
      </div>

      {funnel.total === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          Запросов пока нет. Пометьте заказ «Попросить отзыв» в его карточке.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile n={inWork} label="в работе" />
            {/* Просрочка — единственное, что требует действия прямо сейчас. */}
            <Tile n={funnel.overdue} label="просрочено" tone={funnel.overdue > 0 ? "warn" : undefined} />
            <Tile n={funnel.CONFIRMED} label="отзыв получен" tone="good" />
            <Tile n={lost} label="не получилось" />
          </div>
          <QueueTabs active={tab} counts={screen.counts} basePath={PATH} />
          <ReviewQueue tab={tab} cards={screen.cards} locationsBySite={screen.locationsBySite} />
        </>
      )}
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "warn" | "good" }) {
  const cls =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : tone === "good"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : "border-slate-200 bg-white text-slate-900";
  return (
    <div className={`rounded-xl border px-4 py-3 ${cls}`}>
      <div className="text-2xl font-semibold tabular-nums">{n}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}
