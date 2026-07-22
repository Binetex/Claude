import { requireUser } from "@/lib/rbac";
import { loadPrintableCards } from "@/modules/print/loadPrintable";
import { PrintDocument } from "./PrintDocument";

/**
 * Печатный документ открыток. Маршрут вне dashboard-layout (без chrome). Доступ проверяется
 * сервером повторно (не доверяем query). ids — небольшой список (дедуп + лимит 50 внутри loader);
 * «Все на сегодня» — без ids, сервер выбирает по дате/роли/магазину.
 */
export const dynamic = "force-dynamic";

export default async function PrintOrderCardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const todayAll = sp.today === "1" || sp.today === "true";
  const siteId = sp.siteId?.trim() || undefined;

  const orders = await loadPrintableCards(
    { role: user.role, floristId: user.floristId },
    { ids: ids.length ? ids : undefined, todayAll, siteId }
  );

  return <PrintDocument orders={orders} />;
}
