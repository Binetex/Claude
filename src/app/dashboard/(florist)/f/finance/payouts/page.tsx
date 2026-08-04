import { requireFlorist } from "@/lib/rbac";
import { PayoutsView } from "@/components/finance/PayoutsView";

export const dynamic = "force-dynamic";

/** История выплат флориста. Экран общий с кабинетом владельца — см. PayoutsView. */
export default async function FloristPayoutsPage() {
  const user = await requireFlorist();
  return <PayoutsView floristId={user.floristId} emptyDescription="Здесь появятся выплаты, когда владелец их внесёт." />;
}
