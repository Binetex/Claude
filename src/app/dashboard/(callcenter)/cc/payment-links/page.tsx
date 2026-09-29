import { requireRole } from "@/lib/rbac";
import { PaymentLinksScreen } from "@/components/payments/PaymentLinksScreen";

export const dynamic = "force-dynamic";

/**
 * Ссылки на оплату — у колл-центра (владелец 29.09.2026): оператор сам выставляет счёт клиенту,
 * который решил доплатить, и сам гасит ошибочный.
 */
export default async function CallCenterPaymentLinksPage() {
  await requireRole("CALL_CENTER");
  return <PaymentLinksScreen />;
}
