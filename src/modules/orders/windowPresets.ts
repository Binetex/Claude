import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { windowOf, type WindowRange } from "@/lib/deliveryWindow";

/**
 * Частые окна магазина — кнопки в выборе времени. Берём из его же заказов за 90 дней, настраивать
 * ничего не нужно: у TheFlow это 11–15, 15–19, 18–21, у PAR — 11:30–17:00 и 17:00–20:30.
 * Окно, встретившееся меньше трёх раз, — чья-то ручная правка, а не слот магазина.
 */
export async function loadWindowPresets(prisma: PrismaClient, siteId: string, limit = 4): Promise<WindowRange[]> {
  const rows = await prisma.order.findMany({
    where: { siteId, deliveryDate: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    select: { windowFrom: true, windowTo: true, deliveryWindow: true },
    take: 2000,
  });
  const counts = new Map<string, { r: WindowRange; n: number }>();
  for (const row of rows) {
    const r = windowOf(row);
    if (!r) continue;
    const key = `${r.from}-${r.to}`;
    const c = counts.get(key) ?? { r, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  return [...counts.values()]
    .filter((c) => c.n >= 3)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((c) => c.r)
    .sort((a, b) => a.from - b.from);
}
