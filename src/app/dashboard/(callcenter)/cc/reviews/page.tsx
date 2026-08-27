import { requireUser } from "@/lib/rbac";
import { notFound } from "next/navigation";
import { loadQueueScreen, parseQueueTab } from "@/modules/reviews/queueView";
import { ReviewQueue } from "@/components/reviews/ReviewQueue";
import { QueueTabs } from "@/components/reviews/QueueTabs";

export const dynamic = "force-dynamic";

const PATH = "/dashboard/cc/reviews";

/**
 * Очередь отзывов колл-центра.
 *
 * Вкладки — это не статусы, а состояния работы: «сегодня» собирается по СРОКУ и потому
 * смешивает новые запросы с недозвонами, «ждут» — там, где ход за клиентом.
 *
 * Тот же экран есть у владельца («Отзывы → Очередь»). Общий код — в `queueView`: два человека,
 * смотрящие на «одну» очередь, обязаны видеть одно и то же.
 */
export default async function ReviewsQueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (user.role === "FLORIST") notFound();

  const tab = parseQueueTab((await searchParams).tab);
  const { cards, counts, locationsBySite } = await loadQueueScreen(tab, (id) => `/dashboard/cc/${id}`);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Отзывы</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Заказы, по которым владелец попросил взять отзыв. Отметьте, чем закончился разговор, — остальное
          система сделает сама.
        </p>
      </div>
      <QueueTabs active={tab} counts={counts} basePath={PATH} />
      <ReviewQueue tab={tab} cards={cards} locationsBySite={locationsBySite} />
    </div>
  );
}
