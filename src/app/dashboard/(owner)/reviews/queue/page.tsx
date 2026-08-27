import { requireRole } from "@/lib/rbac";
import { loadQueueScreen, parseQueueTab } from "@/modules/reviews/queueView";
import { ReviewQueue } from "@/components/reviews/ReviewQueue";
import { QueueTabs } from "@/components/reviews/QueueTabs";

export const dynamic = "force-dynamic";

const PATH = "/dashboard/reviews/queue";

/**
 * Та же очередь, что у колл-центра, но в разделе владельца.
 *
 * Нужна потому, что оператор может заболеть или не успеть, а запрос закрыть надо: раньше
 * действия очереди владельца ПУСКАЛИ, но попасть на экран он не мог — раздел колл-центра
 * закрыт по роли. Экран один и тот же, код общий (`queueView`): две очереди, показывающие
 * разное, были бы хуже отсутствия второй.
 */
export default async function OwnerReviewQueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireRole("OWNER");

  const tab = parseQueueTab((await searchParams).tab);
  const { cards, counts, locationsBySite } = await loadQueueScreen(tab, (id) => `/dashboard/orders/${id}`);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Очередь звонков</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          То же, что видит колл-центр. Обычно ведёт запросы оператор — здесь вы можете закрыть или
          засчитать любой из них сами.
        </p>
      </div>
      <QueueTabs active={tab} counts={counts} basePath={PATH} />
      <ReviewQueue tab={tab} cards={cards} locationsBySite={locationsBySite} />
    </div>
  );
}
