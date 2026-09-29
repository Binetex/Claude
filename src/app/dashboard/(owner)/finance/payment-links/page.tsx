import { requireRole } from "@/lib/rbac";
import { PaymentLinksScreen } from "@/components/payments/PaymentLinksScreen";

export const dynamic = "force-dynamic";

/** Ссылки на оплату Airwallex — у владельца во вкладке «Финансов». */
export default async function PaymentLinksPage() {
  await requireRole("OWNER");
  return <PaymentLinksScreen />;
}
