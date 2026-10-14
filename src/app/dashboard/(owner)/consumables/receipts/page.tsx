import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { DEFAULT_STORE_TZ, todayStrInTz } from "@/lib/tz";
import { loadConsumableItems, loadOrdersWithConsumables, usagesOf } from "@/modules/consumables/service";
import { stockByFlorist, stockTotal, NO_FLORIST, type StockCell } from "@/modules/consumables/stock";
import { ReceiptsPanel, type HistoryRow } from "./ReceiptsPanel";

export const dynamic = "force-dynamic";

/**
 * Приход и остаток — по флористам (владелец 14.10.2026: «приход и остаток разделить между
 * флористами»). Флорист выбирается переключателем раздела (`?florist=`): по нему — сколько пришло,
 * передано, ушло в его заказы и осталось; без флориста — остаток каждого рядом и общий.
 *
 * Остаток = приход ± передачи − расход заказов с первого прихода (`modules/consumables/stock.ts`).
 * Считается на лету, а не хранится: расход выводится из заказов, и хранимый остаток разъезжался бы
 * с ними при любой правке задним числом.
 */
export default async function ConsumableReceiptsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const floristId = (await searchParams).florist || undefined;
  const items = await loadConsumableItems(prisma, true);
  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Приход и остаток" description="Сначала создайте справочник во вкладке «Журнал»." />
      </div>
    );
  }

  const [receipts, firstOrder, florists] = await Promise.all([
    prisma.consumableReceipt.findMany({
      orderBy: [{ day: "desc" }, { createdAt: "desc" }],
      select: { id: true, itemId: true, floristId: true, transferId: true, day: true, quantity: true, note: true },
    }),
    prisma.order.findFirst({ orderBy: { deliveryDate: "asc" }, select: { deliveryDate: true } }),
    prisma.florist.findMany({
      select: { id: true, active: true, user: { select: { name: true, active: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  const now = new Date();
  const from = firstOrder?.deliveryDate ?? new Date(0);
  // Верхняя граница с запасом в сутки: заказы на завтра расходники уже потратят.
  const to = new Date(now.getTime() + 86_400_000);
  const orders = await loadOrdersWithConsumables(prisma, { from, to, items });
  const stock = stockByFlorist(
    receipts.map((r) => ({ ...r, day: r.day.toISOString().slice(0, 10) })),
    usagesOf(orders, items)
  );

  const nameOf = new Map(florists.map((f) => [f.id, f.user.name ?? "Флорист"]));
  // Учёт ведётся у тех, у кого был приход (`stock.ts`): у отключённого — только если он что-то вёл.
  const touched = (key: string) => items.some((i) => stock.get(i.id)?.has(key));
  const columns = [
    ...florists
      .filter((f) => (f.active && f.user.active) || touched(f.id))
      .map((f) => ({ key: f.id, name: f.active && f.user.active ? nameOf.get(f.id)! : `${nameOf.get(f.id)} (откл.)` })),
    ...(touched(NO_FLORIST) ? [{ key: NO_FLORIST, name: "Без флориста" }] : []),
  ];
  const activeFlorists = florists.filter((f) => f.active && f.user.active).map((f) => ({ id: f.id, name: nameOf.get(f.id)! }));

  const history = historyRows(receipts, items, nameOf).filter(
    (r) => !floristId || (r.kind === "receipt" ? r.floristId === floristId : r.fromId === floristId || r.toId === floristId)
  );
  const selectedName = floristId ? nameOf.get(floristId) ?? "флорист" : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={selectedName ? `Приход и остаток — ${selectedName}` : "Приход и остаток — все флористы"}
        description={
          selectedName
            ? "Что пришло этому флористу, что он передал или получил и что ушло в его заказы."
            : "Остаток у каждого флориста и общий. Выберите флориста сверху — увидите приход, передачи и расход по нему."
        }
      />

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            {floristId ? (
              <FloristTable items={items} cellOf={(itemId) => stock.get(itemId)?.get(floristId)} />
            ) : (
              <OverviewTable items={items} columns={columns} byItem={(itemId) => stock.get(itemId)} />
            )}
          </div>
        </CardBody>
      </Card>

      <p className="text-[11px] text-slate-400">
        Учёт расходника у флориста начинается с его первого прихода или передачи ему: заказы до этого дня не
        вычитаются. «—» — у флориста этот расходник не ведётся. Чтобы начать с того, что лежит сейчас, запишите
        приход на насчитанное с заметкой «инвентаризация». Минус значит, что приход записан не весь.
      </p>

      <ReceiptsPanel
        items={items.map((i) => ({ id: i.id, name: i.name }))}
        florists={activeFlorists}
        selectedFloristId={floristId ?? null}
        today={todayStrInTz(DEFAULT_STORE_TZ, now)}
        rows={history.slice(0, 200)}
      />
    </div>
  );
}

type Item = { id: string; name: string; imageUrl: string | null };

function ItemName({ item }: { item: Item }) {
  return (
    <span className="flex items-center gap-2">
      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.imageUrl} alt="" className="size-8 rounded object-cover" />
      )}
      {item.name}
    </span>
  );
}

function Left({ cell }: { cell: Omit<StockCell, "since"> | undefined }) {
  if (!cell) return <span className="text-slate-300">—</span>;
  return <span className={`font-medium tabular-nums ${cell.left < 0 ? "text-red-600" : cell.left === 0 ? "text-slate-400" : "text-slate-800"}`}>{cell.left}</span>;
}

const num = (n: number, signed = false) => (n === 0 ? "—" : signed && n > 0 ? `+${n}` : String(n));

/** Один флорист: откуда остаток. */
function FloristTable({ items, cellOf }: { items: Item[]; cellOf: (itemId: string) => StockCell | undefined }) {
  return (
    <table className="w-full text-xs">
      <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
        <tr>
          <th className="px-3 py-2 text-left font-medium">Расходник</th>
          <th className="px-2 py-2 text-right font-medium">Пришло</th>
          <th className="px-2 py-2 text-right font-medium">Передачи</th>
          <th className="px-2 py-2 text-right font-medium">Ушло в заказы</th>
          <th className="px-2 py-2 text-right font-medium">Остаток</th>
          <th className="px-2 py-2 text-right font-medium">Учёт с</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => {
          const c = cellOf(i.id);
          return (
            <tr key={i.id} className="border-b border-slate-100">
              <td className="px-3 py-1.5"><ItemName item={i} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{num(c?.received ?? 0)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{num(c?.transferred ?? 0, true)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{num(c?.used ?? 0)}</td>
              <td className="px-2 py-1.5 text-right"><Left cell={c} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{c ? c.since.split("-").reverse().join(".") : "не ведётся"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Все флористы: остаток каждого рядом и общий. */
function OverviewTable({
  items,
  columns,
  byItem,
}: {
  items: Item[];
  columns: { key: string; name: string }[];
  byItem: (itemId: string) => Map<string, StockCell> | undefined;
}) {
  return (
    <table className="w-full text-xs">
      <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
        <tr>
          <th className="px-3 py-2 text-left font-medium">Расходник</th>
          {columns.map((c) => (
            <th key={c.key || "none"} className="px-2 py-2 text-right font-medium">{c.name}</th>
          ))}
          <th className="px-2 py-2 text-right font-medium">Всего</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => {
          const cells = byItem(i.id);
          return (
            <tr key={i.id} className="border-b border-slate-100">
              <td className="px-3 py-1.5"><ItemName item={i} /></td>
              {columns.map((c) => (
                <td key={c.key || "none"} className="px-2 py-1.5 text-right"><Left cell={cells?.get(c.key)} /></td>
              ))}
              <td className="px-2 py-1.5 text-right"><Left cell={cells?.size ? stockTotal(cells) : undefined} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Записи прихода для истории: две строки передачи — одной строкой «кто → кому». */
function historyRows(
  receipts: { id: string; itemId: string; floristId: string | null; transferId: string | null; day: Date; quantity: number; note: string | null }[],
  items: Item[],
  nameOf: Map<string, string>
): HistoryRow[] {
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const rows: HistoryRow[] = [];
  const transfers = new Map<string, typeof receipts>();
  for (const r of receipts) {
    if (r.transferId) (transfers.get(r.transferId) ?? transfers.set(r.transferId, []).get(r.transferId)!).push(r);
  }
  const seen = new Set<string>();
  for (const r of receipts) {
    const item = itemOf.get(r.itemId);
    const base = { itemId: r.itemId, itemName: item?.name ?? "—", imageUrl: item?.imageUrl ?? null, day: r.day.toISOString().slice(0, 10), note: r.note };
    if (!r.transferId) {
      rows.push({ kind: "receipt", id: r.id, ...base, quantity: r.quantity, floristId: r.floristId, floristName: r.floristId ? nameOf.get(r.floristId) ?? "Флорист" : null });
      continue;
    }
    if (seen.has(r.transferId)) continue;
    seen.add(r.transferId);
    const pair = transfers.get(r.transferId) ?? [];
    const out = pair.find((p) => p.quantity < 0);
    const into = pair.find((p) => p.quantity > 0);
    rows.push({
      kind: "transfer",
      id: r.transferId,
      ...base,
      quantity: Math.abs(into?.quantity ?? out?.quantity ?? r.quantity),
      fromId: out?.floristId ?? null,
      toId: into?.floristId ?? null,
      fromName: out?.floristId ? nameOf.get(out.floristId) ?? "Флорист" : "—",
      toName: into?.floristId ? nameOf.get(into.floristId) ?? "Флорист" : "—",
    });
  }
  return rows;
}
