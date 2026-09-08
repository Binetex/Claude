import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { loadConsumableItems } from "@/modules/consumables/service";
import { ItemsEditor } from "./ItemsEditor";

export const dynamic = "force-dynamic";

export default async function ConsumableItemsPage() {
  const [items, sites] = await Promise.all([
    loadConsumableItems(prisma, true),
    prisma.site.findMany({ select: { id: true, name: true, shortName: true }, orderBy: { name: "asc" } }),
  ]);
  const archived = await prisma.consumableItem.findMany({ where: { archivedAt: { not: null } }, select: { id: true } });
  const archivedIds = new Set(archived.map((a) => a.id));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Справочник расходников"
        description="Колонки журнала. «Считает система» — количество выводится из состава заказа; остальное отмечается руками на странице дня."
      />
      <Card>
        <CardBody className="p-0">
          <ItemsEditor
            items={items.map((i) => ({ ...i, archived: archivedIds.has(i.id) }))}
            sites={sites.map((s) => ({ id: s.id, label: s.shortName || s.name }))}
          />
        </CardBody>
      </Card>
      <p className="text-[11px] text-slate-400">
        Позиции не удаляются, а убираются из списка: у прошлых дней остались проставленные количества,
        и удаление стёрло бы историю.
      </p>
    </div>
  );
}
