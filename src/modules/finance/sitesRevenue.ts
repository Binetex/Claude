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
import { formatDayLabel, seriesColor } from "@/components/charts/theme";
import { eachDay } from "./period";

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
 * Расчёт прибыли складывает «товары + налог + доставка + чаевые». Это НЕ всегда то же самое:
 * `manualOrder.ts` кладёт в `itemsTotal` сумму ДО скидки и вычитает её только в
 * `customerTotal`, поэтому на ручном заказе со скидкой две формулы расходятся ровно на неё.
 * У Shopify и Woo позиции приходят уже со скидкой, и там числа совпадают.
 *
 * Поэтому здесь `customerTotal`: он верен для всех трёх источников и совпадает с суммой,
 * которая стоит в карточке заказа рядом.
 */
const revenueOf = (s: { customerTotal: unknown } | null | undefined): number =>
  s ? toCents(s.customerTotal) : 0;

/** Средний чек. Ноль заказов — ноль, а не деление на ноль. */
const avgOf = (revenueCents: number, orders: number): number =>
  orders > 0 ? Math.round(revenueCents / orders) : 0;

export type SiteRevenueRow = {
  siteId: string;
  name: string;
  /** Короткий код магазина. На узком экране полное имя съедает место у цифр. */
  shortName: string;
  ordersTotal: number;
  revenueCents: number;
  avgCents: number;
};

/**
 * Магазин на графике. Цвет приходит С СЕРВЕРА и закреплён за магазином навсегда: он берётся
 * из позиции в ПОЛНОМ списке магазинов по дате создания. Считать цвет на клиенте по месту в
 * серии нельзя — магазин без заказов за период из серии выпадает и перекрашивает всех
 * следующих, из-за чего при смене дат цвета «скачут».
 *
 * Порядок по дате создания, а не по имени: новый магазин получает следующий свободный цвет
 * и никого не сдвигает, а переименование ничего не меняет.
 */
export type SiteSeries = { siteId: string; name: string; color: string };

/**
 * Один КАЛЕНДАРНЫЙ день диапазона. Выручка магазина лежит под ключом-siteId — так столбец
 * собирается из сегментов без второго справочника, а имена магазинов (они могут совпадать)
 * ключами не работают.
 *
 * Дни без заказов присутствуют с нулями: иначе ось времени рвётся и «провал продаж»
 * выглядит как «этого дня не было».
 */
export type SiteDailyPoint = {
  day: string;
  /** Подпись оси: «1 авг». */
  label: string;
  /** Вся выручка дня по всем магазинам. */
  total: number;
  /** Сколько заказов в этот день — для тултипа. */
  orders: number;
} & Record<string, number | string>;

export type SitesRevenue = {
  rows: SiteRevenueRow[];
  ordersTotal: number;
  revenueCents: number;
  avgCents: number;
  /** Магазины с заказами за период, по алфавиту — порядок задаёт цвета и стопку. */
  series: SiteSeries[];
  points: SiteDailyPoint[];
};

const where = (from: Date, to: Date, siteId?: string) => ({
  deliveryDate: { gte: from, lte: to },
  orderStatus: { notIn: COUNTED_STATUSES },
  ...(siteId ? { siteId } : {}),
});

/**
 * Всё, что нужно странице магазинов, ОДНИМ запросом: и таблица итогов, и дневная динамика.
 *
 * Группировка одна — день × магазин. Итог магазина за период получается сложением его дней,
 * поэтому второй формулы не возникает, а таблица и график физически не могут разойтись.
 *
 * `from`/`to` — UTC-полночь первого и последнего дня (конвенция `Order.deliveryDate`).
 * Магазины без заказов за период не показываются нигде: строка и сегмент из нулей ничего
 * не сообщают. А вот ДНИ без заказов остаются — ось времени должна быть непрерывной.
 */
export async function getSitesRevenue(from: Date, to: Date): Promise<SitesRevenue> {
  const [grouped, sites] = await Promise.all([
    prisma.order.groupBy({
      by: ["deliveryDate", "siteId"],
      where: where(from, to),
      _count: { _all: true },
      _sum: { customerTotal: true },
    }),
    prisma.site.findMany({ select: { id: true, name: true, shortName: true }, orderBy: { createdAt: "asc" } }),
  ]);

  const nameById = new Map(sites.map((s) => [s.id, s.name]));
  const shortById = new Map(sites.map((s) => [s.id, s.shortName]));
  // Цвет — по месту в полном списке магазинов, поэтому от выбранного периода не зависит.
  const colorById = new Map(sites.map((s, i) => [s.id, seriesColor(i)]));

  // Итоги магазина = сумма его дней. Отдельного запроса под таблицу нет.
  const bySite = new Map<string, { ordersTotal: number; revenueCents: number }>();
  const byDay = new Map<string, Map<string, { orders: number; revenue: number }>>();

  for (const g of grouped) {
    const revenue = revenueOf(g._sum);
    const orders = g._count._all;

    const site = bySite.get(g.siteId) ?? { ordersTotal: 0, revenueCents: 0 };
    site.ordersTotal += orders;
    site.revenueCents += revenue;
    bySite.set(g.siteId, site);

    const key = g.deliveryDate.toISOString().slice(0, 10);
    const day = byDay.get(key) ?? new Map();
    day.set(g.siteId, { orders, revenue });
    byDay.set(key, day);
  }

  const rows: SiteRevenueRow[] = [...bySite.entries()]
    .map(([siteId, v]) => ({
      siteId,
      name: nameById.get(siteId) ?? siteId,
      shortName: shortById.get(siteId) ?? siteId,
      ordersTotal: v.ordersTotal,
      revenueCents: v.revenueCents,
      avgCents: avgOf(v.revenueCents, v.ordersTotal),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);

  // В серии попадают только магазины с заказами за период — пустой сегмент ничего не
  // сообщает. Порядок по имени: он задаёт порядок стопки и легенды, но НЕ цвет.
  const series: SiteSeries[] = rows
    .map((r) => ({ siteId: r.siteId, name: r.name, color: colorById.get(r.siteId) ?? seriesColor(0) }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const points: SiteDailyPoint[] = eachDay(from, to).map((day) => {
    const cells = byDay.get(day);
    const point: SiteDailyPoint = { day, label: formatDayLabel(day), total: 0, orders: 0 };
    for (const s of series) {
      const cell = cells?.get(s.siteId);
      point[s.siteId] = cell?.revenue ?? 0;
      point.total += cell?.revenue ?? 0;
      point.orders += cell?.orders ?? 0;
    }
    return point;
  });

  const ordersTotal = rows.reduce((a, r) => a + r.ordersTotal, 0);
  const revenueCents = rows.reduce((a, r) => a + r.revenueCents, 0);

  return {
    rows,
    ordersTotal,
    revenueCents,
    avgCents: avgOf(revenueCents, ordersTotal),
    series,
    points,
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
