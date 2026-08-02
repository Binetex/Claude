import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { listBurqDeliveryCandidates } from "@/modules/finance/fix";
import { BurqDeliveryTable } from "./BurqDeliveryTable";

export const dynamic = "force-dynamic";

export default async function BurqDeliveryPage() {
  await requireRole("OWNER");
  const candidates = await listBurqDeliveryCandidates();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Подтверждение доставки по суммам Burq"
        description="Только заказы, у которых сумма курьера уже есть. Заказы без неё сюда не попадают: у каждой доставки своя цена, и подставлять общее значение было бы выдумыванием данных."
        actions={
          <Link href="/dashboard/finance/setup" className="text-sm text-slate-500 hover:text-slate-800">
            К очереди
          </Link>
        }
      />

      {candidates.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Подтверждать нечего"
              description="Либо стоимость доставки уже подтверждена везде, либо у оставшихся заказов нет записи Burq — их придётся заполнить вручную из очереди."
            />
          </CardBody>
        </Card>
      ) : (
        <BurqDeliveryTable candidates={candidates} />
      )}
    </div>
  );
}
