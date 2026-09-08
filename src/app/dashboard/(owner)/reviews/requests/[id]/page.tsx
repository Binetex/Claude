import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { loadRequestDetail } from "@/modules/reviews/requestView";
import { RequestDetail } from "@/components/reviews/RequestDetail";

export const dynamic = "force-dynamic";

/**
 * Карточка запроса отзыва у владельца. Тот же экран есть у колл-центра — компонент и загрузка
 * общие: двое, глядящие на «один» запрос, обязаны видеть одно и то же.
 */
export default async function OwnerReviewRequestPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("OWNER");
  const { id } = await params;
  const vm = await loadRequestDetail(id, (orderId) => `/dashboard/orders/${orderId}`);
  if (!vm) notFound();
  return <RequestDetail vm={vm} backHref="/dashboard/reviews/requests" />;
}
