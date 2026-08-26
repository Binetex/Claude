import { requireRole } from "@/lib/rbac";
import { listLocationsBySite } from "@/modules/reviews/locations";
import { LocationsPanel } from "./LocationsPanel";

export const dynamic = "force-dynamic";

/**
 * Раздел «Отзывы». Пока в нём только точки — воронка запросов и мониторинг Google придут
 * следующими этапами. Пустых вкладок под них заранее не заводим: вкладка, за которой ничего
 * нет, читается как поломка.
 */
export default async function ReviewsPage() {
  await requireRole("OWNER");
  const sites = await listLocationsBySite();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Точки на картах</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Каждый заказ уходит к ближайшей точке магазина: укажите у точки её собственный индекс,
          остальное система посчитает сама. Запасная точка нужна на случай, когда индекс заказа
          неизвестен. Проверить конкретный адрес можно тут же — поле справа от названия магазина.
        </p>
      </div>
      <LocationsPanel sites={sites} />
    </div>
  );
}
