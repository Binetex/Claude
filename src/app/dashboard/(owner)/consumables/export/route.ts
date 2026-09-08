import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { DEFAULT_STORE_TZ, localDateStr, zonedLocalTimeToUtc } from "@/lib/tz";
import { loadConsumableItems, loadOrdersWithConsumables, totalsFor } from "@/modules/consumables/service";

/**
 * Выгрузка месяца в CSV — тот же вид, что владелец вёл в Google Sheets.
 *
 * Своя проверка прав: route handler не проходит через layout раздела, и без неё выгрузка была бы
 * открыта любому аутентифицированному.
 */
export async function GET(req: Request) {
  await requireRole("OWNER");

  const url = new URL(req.url);
  const tz = DEFAULT_STORE_TZ;
  const monthParam = url.searchParams.get("month");
  const month = /^\d{4}-\d{2}$/.test(monthParam ?? "") ? (monthParam as string) : localDateStr(new Date(), tz).slice(0, 7);
  const floristId = url.searchParams.get("florist") || undefined;

  const from = zonedLocalTimeToUtc(`${month}-01`, "00:00", tz);
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const to = zonedLocalTimeToUtc(`${next}-01`, "00:00", tz);

  const items = await loadConsumableItems(prisma);
  const orders = await loadOrdersWithConsumables(prisma, { from, to, floristId, items });

  const orderDays = await prisma.order.findMany({
    where: { id: { in: orders.map((o) => o.orderId) } },
    select: { id: true, deliveryDate: true },
  });
  const dayOf = new Map(orderDays.map((o) => [o.id, o.deliveryDate.toISOString().slice(0, 10)]));

  const byDay = new Map<string, typeof orders>();
  for (const o of orders) {
    const key = dayOf.get(o.orderId);
    if (!key) continue;
    const list = byDay.get(key) ?? [];
    list.push(o);
    byDay.set(key, list);
  }

  const esc = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows: string[] = [];
  rows.push(["Дата", "Заказов", "Номера заказов", ...items.map((i) => i.name)].map(esc).join(","));

  for (const [day, list] of [...byDay.entries()].sort()) {
    const totals = totalsFor(list, items);
    rows.push([
      day,
      String(list.length),
      list.map((o) => o.orderNumber).join(", "),
      ...items.map((i) => String(totals.get(i.id) ?? 0)),
    ].map(esc).join(","));
  }

  const monthTotals = totalsFor(orders, items);
  rows.push(["Итого", String(orders.length), "", ...items.map((i) => String(monthTotals.get(i.id) ?? 0))].map(esc).join(","));

  // BOM: без него Excel открывает кириллицу кракозябрами.
  const body = "﻿" + rows.join("\r\n");
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="consumables-${month}.csv"`,
      "cache-control": "no-store",
    },
  });
}
