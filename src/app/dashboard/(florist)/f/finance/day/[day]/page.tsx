import { notFound } from "next/navigation";
import { requireFlorist } from "@/lib/rbac";
import { isDayKey } from "@/modules/finance/earnings";
import { FinanceDayView } from "@/components/finance/FinanceDayView";

export const dynamic = "force-dynamic";

/**
 * Финансы одного дня в кабинете флориста. Содержимое — общий FinanceDayView, тот же, что у
 * владельца: до объединения это были две страницы поверх одного readShareDayBreakdown.
 *
 * В маршруте нет floristId: профиль берётся из сессии, чужой день посмотреть нельзя.
 */
export default async function FloristFinanceDayPage({ params }: { params: Promise<{ day: string }> }) {
  const user = await requireFlorist();
  const { day } = await params;
  if (!isDayKey(day)) notFound();

  return (
    <FinanceDayView
      floristId={user.floristId}
      day={day}
      backHref="/dashboard/f/finance"
      backLabel="← К заработку"
      orderHrefBase="/dashboard/f"
    />
  );
}
