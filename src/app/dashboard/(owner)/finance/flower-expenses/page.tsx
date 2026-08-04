import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { activePrimaryProfile } from "@/modules/finance/flowerExpenses";

/**
 * Старый адрес раздела «Расходы на цветы». Своего экрана больше НЕ имеет: закупка
 * привязана к основному флористу и живёт вкладкой в его кабинете.
 *
 * Маршрут оставлен ПЕРЕНАПРАВЛЕНИЕМ, а не удалён: на него ведут ссылки из «Требует
 * заполнения» и из настроек расчёта, и ломать их ради переезда незачем. UI здесь нет —
 * дублирования тоже.
 */
export default async function FlowerExpensesRedirect() {
  await requireRole("OWNER");
  const profile = await activePrimaryProfile();
  redirect(
    profile
      ? `/dashboard/finance/florists/${profile.floristId}/flower-expenses`
      : "/dashboard/finance/florists"
  );
}
