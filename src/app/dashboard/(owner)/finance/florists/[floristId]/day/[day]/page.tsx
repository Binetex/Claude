import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { isDayKey } from "@/modules/finance/earnings";
import { FinanceDayView } from "@/components/finance/FinanceDayView";
import { RecomputeDayButton } from "./RecomputeDayButton";

export const dynamic = "force-dynamic";

/**
 * Разбор одного дня флориста глазами владельца.
 *
 * Тот же FinanceDayView, что в кабинете самого флориста; владельческое — только кнопка
 * пересчёта. Попадают сюда через «Финансы → Флористы → флорист → день»: отдельной
 * верхнеуровневой навигации «Доля основного флориста» больше нет.
 */
export default async function OwnerFloristDayPage({
  params,
}: {
  params: Promise<{ floristId: string; day: string }>;
}) {
  await requireRole("OWNER");
  const { floristId, day } = await params;
  if (!isDayKey(day)) notFound();

  return (
    <FinanceDayView
      floristId={floristId}
      day={day}
      backHref={`/dashboard/finance/florists/${floristId}`}
      backLabel="← К заработку"
      orderHrefBase="/dashboard/orders"
      actions={<RecomputeDayButton day={day} floristId={floristId} />}
    />
  );
}
