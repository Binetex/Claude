import { requireRole } from "@/lib/rbac";
import { PayoutsView } from "@/components/finance/PayoutsView";

export const dynamic = "force-dynamic";

/** История выплат флориста глазами владельца. Тот же экран, что видит сам флорист. */
export default async function OwnerFloristPayoutsPage({ params }: { params: Promise<{ floristId: string }> }) {
  await requireRole("OWNER");
  const { floristId } = await params;
  return <PayoutsView floristId={floristId} emptyDescription="Внесите выплату кнопкой в шапке." />;
}
