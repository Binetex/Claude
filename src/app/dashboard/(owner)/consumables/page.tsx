import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";
import { DEFAULT_STORE_TZ, localDateStr, zonedLocalTimeToUtc } from "@/lib/tz";
import { loadConsumableItems, loadOrdersWithConsumables, totalsFor, type OrderConsumableRow } from "@/modules/consumables/service";
import { SetupPanel } from "./SetupPanel";

export const dynamic = "force-dynamic";

/**
 * Журнал расходников — аналог таблицы, которую владелец вёл в Google Sheets: строка = день,
 * колонки = позиции справочника. Числа считаются правилом по позициям заказа; проставленное
 * руками показывается пунктиром, чтобы было видно, где расчёт, а где решение человека.
 */
function monthRange(monthStr: string | undefined, tz: string): { from: Date; to: Date; month: string } {
  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(monthStr ?? "") ? (monthStr as string) : localDateStr(now, tz).slice(0, 7);
  const from = zonedLocalTimeToUtc(`${month}-01`, "00:00", tz);
  const [y, m] = month.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const to = zonedLocalTimeToUtc(`${nextMonth}-01`, "00:00", tz);
  return { from, to, month };
}

export default async function ConsumablesJournalPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tz = DEFAULT_STORE_TZ;
  const { from, to, month } = monthRange(sp.month, tz);
  const floristId = sp.florist || undefined;

  const [items, florists, sites] = await Promise.all([
    loadConsumableItems(prisma),
    prisma.florist.findMany({ where: { active: true }, select: { id: true, user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } }),
    prisma.site.findMany({ select: { id: true, name: true, shortName: true }, orderBy: { name: "asc" } }),
  ]);

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Расходники" description="Что положили в заказы: коробки, конверты, вазы и записки Care Guide." />
        <SetupPanel sites={sites.map((s) => ({ id: s.id, label: s.shortName || s.name }))} />
      </div>
    );
  }

  const orders = await loadOrdersWithConsumables(prisma, { from, to, floristId, items });

  // Дни считаем по календарю магазина: deliveryDate хранится UTC-полночью локального дня.
  const dayOf = new Map<string, string>();
  const orderDays = await prisma.order.findMany({
    where: { id: { in: orders.map((o) => o.orderId) } },
    select: { id: true, deliveryDate: true },
  });
  for (const o of orderDays) dayOf.set(o.id, o.deliveryDate.toISOString().slice(0, 10));

  const byDay = new Map<string, OrderConsumableRow[]>();
  for (const o of orders) {
    const key = dayOf.get(o.orderId);
    if (!key) continue;
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(o);
  }

  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const monthTotals = totalsFor(orders, items);
  const unknownTotal = orders.reduce((n, o) => n + o.unknownVases, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Расходники"
        description="Что положили в заказы: коробки, конверты, вазы и записки Care Guide. Вазы, донышки и записки система считает сама по составу заказа; коробки и обычный конверт отмечаются вручную на странице дня."
      />

      <Card>
        <CardBody>
          <form method="get" className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">Месяц</span>
              <Input type="month" name="month" defaultValue={month} className="h-9 w-40" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">Флорист</span>
              <Select name="florist" defaultValue={floristId ?? ""} wrapperClassName="w-44">
                <option value="">все флористы</option>
                {florists.map((f) => (
                  <option key={f.id} value={f.id}>{f.user.name}</option>
                ))}
              </Select>
            </label>
            <Button type="submit" size="sm">Показать</Button>
            <Button asChild size="sm" variant="outline">
              <a href={`/dashboard/consumables/export?month=${month}${floristId ? `&florist=${floristId}` : ""}`}>
                Выгрузить CSV
              </a>
            </Button>
          </form>
        </CardBody>
      </Card>

      {unknownTotal > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          У {unknownTotal} ваз(ы) не удалось определить тип по названию. Донышко и записку они получили,
          но в колонку конкретной вазы не попали — поправьте название в каталоге или проставьте вручную.
        </div>
      )}

      {days.length === 0 ? (
        <EmptyState title="За этот месяц заказов нет" description="Выберите другой месяц или снимите фильтр по флористу." />
      ) : (
        <Card>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left font-medium">Дата</th>
                    <th className="px-2 py-2 text-right font-medium">Заказов</th>
                    {items.map((i) => (
                      <th key={i.id} className="px-2 py-2 text-right font-medium align-bottom">
                        <span className="flex flex-col items-end gap-1">
                          {i.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={i.imageUrl} alt="" className="size-8 rounded object-cover" />
                          )}
                          <span className="whitespace-nowrap">{i.name}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days.map(([day, list]) => {
                    const totals = totalsFor(list, items);
                    return (
                      <tr key={day} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="sticky left-0 z-10 bg-white px-3 py-1.5">
                          <Link href={`/dashboard/consumables/${day}`} className="font-medium text-sky-700 hover:underline">
                            {day.split("-").reverse().join(".")}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{list.length}</td>
                        {items.map((i) => (
                          <td key={i.id} className="px-2 py-1.5 text-right tabular-nums">
                            <Cell value={totals.get(i.id) ?? 0} manual={list.some((o) => o.manual.has(i.id))} auto={!!i.autoRule} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-50 font-medium">
                    <td className="sticky left-0 z-10 bg-slate-50 px-3 py-2">Итого за месяц</td>
                    <td className="px-2 py-2 text-right tabular-nums">{orders.length}</td>
                    {items.map((i) => (
                      <td key={i.id} className="px-2 py-2 text-right tabular-nums">{monthTotals.get(i.id) ?? 0}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      <p className="text-[11px] text-slate-400">
        Обычное число — посчитано по составу заказа. <span className="underline decoration-dotted">Пунктиром</span> — есть ручная правка.
        «—» в колонке, которую система не считает (коробки, обычный конверт), значит «не отмечено».
      </p>
    </div>
  );
}

function Cell({ value, manual, auto }: { value: number; manual: boolean; auto: boolean }) {
  if (!value && !auto && !manual) return <span className="text-slate-300">—</span>;
  if (!value) return <span className="text-slate-400">0</span>;
  return <span className={manual ? "underline decoration-dotted decoration-slate-400" : ""}>{value}</span>;
}
