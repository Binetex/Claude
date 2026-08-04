import { requireFlorist } from "@/lib/rbac";
import { EarningsView } from "@/components/finance/EarningsView";

export const dynamic = "force-dynamic";

/**
 * Заработок флориста: сколько я заработал и из каких дней.
 *
 * В маршруте СОЗНАТЕЛЬНО нет сегмента [floristId]: id берётся из сессии через requireFlorist,
 * подставить чужой физически некуда. Владелец смотрит тот же экран по адресу
 * /dashboard/finance/florists/[floristId] — и это буквально тот же компонент, чтобы числа у
 * него и у флориста не могли разойтись.
 */
export default async function FloristEarningsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  return (
    <EarningsView
      floristId={user.floristId}
      searchParams={await searchParams}
      basePath="/dashboard/f/finance"
      dayHrefBase="/dashboard/f/finance/day"
      orderHrefBase="/dashboard/f"
    />
  );
}
