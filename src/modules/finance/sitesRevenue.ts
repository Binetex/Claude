import "server-only";
/**
 * Выручка по магазинам: сколько заказов и денег приносит каждый.
 *
 * ЭТО НЕ ПРИБЫЛЬ И НЕ ПЫТАЕТСЯ ЕЮ БЫТЬ. Главный расход дня — общая закупка цветов — к
 * магазину не привязан вовсе (`DailyFlowerExpense` знает день и профиль флориста, но не
 * магазин), а доля основного флориста считается от прибыли ДНЯ ЦЕЛИКОМ, сразу по всем
 * магазинам. Разложить их по магазинам можно только выдумав правило дележа, поэтому
 * страница на прибыль и не замахивается: она отвечает на вопрос «кто сколько продаёт».
 *
 * Отсюда же и простота: своей формулы здесь нет, второй версии прибыли не появляется, и
 * ломаться при правках расчёта нечему. Всё считается двумя `groupBy` на чтении.
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import type { OrderStatus } from "@/generated/prisma/enums";

/**
 * Что считаем заказом магазина.
 *
 * Отменённые и ожидающие оплаты не в счёт: денег по ним нет. Остальные — да, включая
 * сегодняшние ещё не доставленные, иначе вкладки «Сегодня» и «Вчера» были бы всегда пустыми.
 *
 * Из-за этого выручка здесь ШИРЕ, чем на «Обзоре»: тот считает только доставленные, потому
 * что говорит о прибыли, а прибыль появляется по факту. Здесь речь о продажах.
 */
const COUNTED_STATUSES: OrderStatus[] = ["CANCELLED", "AWAITING_PAYMENT"];

const toCents = (v: unknown) => Math.round(toNumber(v as never) * 100);

/**
 * Выручка — `customerTotal`, то есть сколько клиент заплатил на самом деле.
 *
 * Не сумма «товары + налог + доставка + чаевые», которой пользуется расчёт прибыли: та НЕ
 * вычитает скидку и на заказе со скидкой $25 показывает на $25 больше, чем стоит в карточке
 * заказа. Для страницы про продажи это было бы прямое противоречие тому, что видно рядом.
 */
const revenueOf = (s: { customerTotal: unknown } | null | undefined): number =>
  s ? toCents(s.customerTotal) : 0;

/** Средний чек. Ноль заказов — ноль, а не деление на ноль. */
const avgOf = (revenueCents: number, orders: number): number =>
  orders > 0 ? Math.round(revenueCents / orders) : 0;

export type SiteRevenueRow = {
  siteId: string;
  name: string;
  ordersTotal: number;
  revenueCents: number;
  avgCents: number;
};

export type SitesRevenue = {
  rows: SiteRevenueRow[];
  ordersTotal: number;
  revenueCents: number;
  avgCents: number;
  /** Лучший по выручке. NULL — заказов за период не было. */
  topSite: { name: string; revenueCents: number } | null;
};

const where = (from: Date, to: Date, siteId?: string) => ({
  deliveryDate: { gte: from, lte: to },
  orderStatus: { notIn: COUNTED_STATUSES },
  ...(siteId ? { siteId } : {}),
});

/**
 * Строки таблицы магазинов за период. `from`/`to` — UTC-полночь первого и последнего дня
 * (та же конвенция, что у `Order.deliveryDate`).
 *
 * Магазины без заказов за период не показываются: строка из нулей ничего не сообщает.
 */
export async function getSitesRevenue(from: Date, to: Date): Promise<SitesRevenue> {
  const [grouped, sites] = await Promise.all([
    prisma.order.groupBy({
      by: ["siteId"],
      where: where(from, to),
      _count: { _all: true },
      _sum: { customerTotal: true },
    }),
    prisma.site.findMany({ select: { id: true, name: true } }),
  ]);

  const nameById = new Map(sites.map((s) => [s.id, s.name]));

  const rows: SiteRevenueRow[] = grouped
    .map((g) => {
      const revenueCents = revenueOf(g._sum);
      return {
        siteId: g.siteId,
        name: nameById.get(g.siteId) ?? g.siteId,
        ordersTotal: g._count._all,
        revenueCents,
        avgCents: avgOf(revenueCents, g._count._all),
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  const ordersTotal = rows.reduce((a, r) => a + r.ordersTotal, 0);
  const revenueCents = rows.reduce((a, r) => a + r.revenueCents, 0);

  return {
    rows,
    ordersTotal,
    revenueCents,
    avgCents: avgOf(revenueCents, ordersTotal),
    // Строки уже отсортированы по выручке — лучший это первая.
    topSite: rows[0] ? { name: rows[0].name, revenueCents: rows[0].revenueCents } : null,
  };
}

export type SiteDay = { day: string; ordersTotal: number; revenueCents: number };

export type SiteDetail = {
  siteId: string;
  name: string;
  ordersTotal: number;
  revenueCents: number;
  avgCents: number;
  /** Дни от новых к старым. Дни без заказов пропускаются. */
  days: SiteDay[];
};

/** Один магазин за период, с разбивкой по дням. NULL — такого магазина нет. */
export async function getSiteDetail(siteId: string, from: Date, to: Date): Promise<SiteDetail | null> {
  const [site, grouped] = await Promise.all([
    prisma.site.findUnique({ where: { id: siteId }, select: { id: true, name: true } }),
    prisma.order.groupBy({
      by: ["deliveryDate"],
      where: where(from, to, siteId),
      _count: { _all: true },
      _sum: { customerTotal: true },
    }),
  ]);
  if (!site) return null;

  const days: SiteDay[] = grouped
    .map((g) => ({
      day: g.deliveryDate.toISOString().slice(0, 10),
      ordersTotal: g._count._all,
      revenueCents: revenueOf(g._sum),
    }))
    .sort((a, b) => b.day.localeCompare(a.day));

  const ordersTotal = days.reduce((a, d) => a + d.ordersTotal, 0);
  const revenueCents = days.reduce((a, d) => a + d.revenueCents, 0);

  return {
    siteId: site.id,
    name: site.name,
    ordersTotal,
    revenueCents,
    avgCents: avgOf(revenueCents, ordersTotal),
    days,
  };
}
