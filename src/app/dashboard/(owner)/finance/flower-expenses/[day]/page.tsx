import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { activePrimaryProfile } from "@/modules/finance/flowerExpenses";

/**
 * Старый адрес одного дня закупки. Перенаправление на тот же день в кабинете основного
 * флориста — на него ведёт кнопка «Внести закупку» из «Требует заполнения».
 */
export default async function FlowerExpenseDayRedirect({ params }: { params: Promise<{ day: string }> }) {
  await requireRole("OWNER");
  const { day } = await params;
  const profile = await activePrimaryProfile();
  redirect(
    profile
      ? `/dashboard/finance/florists/${profile.floristId}/flower-expenses/${day}`
      : "/dashboard/finance/florists"
  );
}
