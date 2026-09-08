import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { loadConsumableItems, loadOrdersWithConsumables, totalsFor } from "@/modules/consumables/service";
import { ReceiptsPanel } from "./ReceiptsPanel";

export const dynamic = "force-dynamic";

/**
 * Приход и остаток.
 *
 * Остаток = всё, что купили, минус всё, что ушло по заказам за всю историю. Считается на лету,
 * а не хранится: расход выводится из заказов, и хранимый остаток разъезжался бы с ними при любой
 * правке задним числом.
 */
export default async function ConsumableReceiptsPage() {
  const items = await loadConsumableItems(prisma, true);
  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Приход и остаток" description="Сначала создайте справочник во вкладке «Журнал»." />
      </div>
    );
  }

  const [receipts, firstOrder] = await Promise.all([
    prisma.consumableReceipt.findMany({
      orderBy: { day: "desc" },
      take: 200,
      select: { id: true, itemId: true, day: true, quantity: true, note: true },
    }),
    prisma.order.findFirst({ orderBy: { deliveryDate: "asc" }, select: { deliveryDate: true } }),
  ]);

  const now = new Date();
  const from = firstOrder?.deliveryDate ?? new Date(0);
  // Верхняя граница с запасом в сутки: заказы на завтра расходники уже потратят.
  const to = new Date(now.getTime() + 86_400_000);
  const orders = await loadOrdersWithConsumables(prisma, { from, to, items });
  const spent = totalsFor(orders, items);

  const received = new Map<string, number>();
  for (const r of receipts) received.set(r.itemId, (received.get(r.itemId) ?? 0) + r.quantity);

  const nameById = new Map(items.map((i) => [i.id, i.name]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Приход и остаток"
        description="Сколько купили, сколько ушло по заказам и что осталось. Расход считается по всей истории заказов, приход — по записям ниже."
      />

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Расходник</th>
                  <th className="px-2 py-2 text-right font-medium">Куплено</th>
                  <th className="px-2 py-2 text-right font-medium">Ушло в заказы</th>
                  <th className="px-2 py-2 text-right font-medium">Остаток</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const got = received.get(i.id) ?? 0;
                  const used = spent.get(i.id) ?? 0;
                  const left = got - used;
                  return (
                    <tr key={i.id} className="border-b border-slate-100">
                      <td className="px-3 py-1.5">{i.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{got || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{used || "—"}</td>
                      <td className={`px-2 py-1.5 text-right font-medium tabular-nums ${left < 0 ? "text-red-600" : left === 0 ? "text-slate-400" : "text-slate-800"}`}>
                        {got === 0 && used === 0 ? "—" : left}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <p className="text-[11px] text-slate-400">
        Минус в остатке значит, что приход записан не весь: расход берётся из заказов и всегда полный.
      </p>

      <ReceiptsPanel
        items={items.map((i) => ({ id: i.id, name: i.name }))}
        receipts={receipts.map((r) => ({
          id: r.id,
          itemName: nameById.get(r.itemId) ?? "—",
          day: r.day.toISOString().slice(0, 10),
          quantity: r.quantity,
          note: r.note,
        }))}
      />
    </div>
  );
}
