import { redirect } from "next/navigation";
import { parseQueueTab } from "@/modules/reviews/queueView";

/**
 * «Очередь» слита с «Запросами» в один рабочий экран (решение владельца, 2026-08-31).
 * Адрес оставлен редиректом: закладки и старые ссылки из уведомлений не должны падать.
 */
export default async function OwnerReviewQueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const tab = parseQueueTab((await searchParams).tab);
  redirect(`/dashboard/reviews/requests?tab=${tab}`);
}
