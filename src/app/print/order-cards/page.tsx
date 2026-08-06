import { requireUser } from "@/lib/rbac";
import { loadPrintableCards, type PrintDay } from "@/modules/print/loadPrintable";
import { PrintDocument } from "./PrintDocument";
import { prisma } from "@/lib/db";
import type { PrintLayout } from "./printCss";

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
  // ?today=1 — прежний формат ссылок, остаётся синонимом ?day=today.
  const todayAll = sp.today === "1" || sp.today === "true";
  const day: PrintDay | undefined = sp.day === "tomorrow" ? "tomorrow" : sp.day === "today" || todayAll ? "today" : undefined;
  const siteId = sp.siteId?.trim() || undefined;

  const orders = await loadPrintableCards(
    { role: user.role, floristId: user.floristId },
    { ids: ids.length ? ids : undefined, day, siteId }
  );

  // Раскладку выбирает настройка флориста «Полная цена» / «Только своя цена»
  // (`financeVisibility`). Печатает всегда сам флорист и только свои заказы, поэтому
  // документ целиком в одной раскладке — двух ориентаций листа на принтер не отправить.
  const florist = user.floristId
    ? await prisma.florist.findUnique({ where: { id: user.floristId }, select: { financeVisibility: true } })
    : null;
  const layout: PrintLayout = florist?.financeVisibility === "FULL" ? "tall" : "wide";

  return <PrintDocument orders={orders} layout={layout} />;
}
