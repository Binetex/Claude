import { requireRole } from "@/lib/rbac";
import { getFunnelCounts } from "@/modules/reviews/funnel";
import { ReviewTabs } from "./ReviewTabs";

/**
 * Обвязка раздела «Отзывы»: вкладки на каждой странице.
 *
 * requireRole здесь дублирует проверку страниц сознательно — layout закрывает и те страницы,
 * которые кто-то добавит в раздел позже и забудет закрыть.
 */
export default async function ReviewsLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");
  const funnel = await getFunnelCounts();

  return (
    <div className="space-y-4">
      <ReviewTabs
        tabs={[
          // Первой — работа: с вопроса «как идёт» в раздел и заходят. Справочник точек нужен
          // редко, когда что-то меняется на картах.
          { href: "/dashboard/reviews/requests", label: "Запросы", badge: funnel.overdue, alarming: funnel.overdue > 0 },
          { href: "/dashboard/reviews/queue", label: "Очередь" },
          { href: "/dashboard/reviews", label: "Точки" },
          { href: "/dashboard/reviews/messages", label: "Сообщения" },
        ]}
      />
      {children}
    </div>
  );
}
