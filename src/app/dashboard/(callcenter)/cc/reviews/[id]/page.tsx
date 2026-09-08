import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { loadRequestDetail } from "@/modules/reviews/requestView";
import { RequestDetail } from "@/components/reviews/RequestDetail";

export const dynamic = "force-dynamic";

/** Карточка запроса отзыва у оператора. Флорист сюда не ходит, как и в саму очередь. */
export default async function CcReviewRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user.role === "FLORIST") notFound();
  const { id } = await params;
  const vm = await loadRequestDetail(id, (orderId) => `/dashboard/cc/${orderId}`);
  if (!vm) notFound();
  return <RequestDetail vm={vm} backHref="/dashboard/cc/reviews" />;
}
