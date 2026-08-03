import "server-only";
/**
 * Заработок флориста для его кабинета: сколько и из каких заказов.
 *
 * Экран не должен знать, основной перед ним флорист или второстепенный, — правила разные,
 * ответ один. Поэтому вся развилка живёт здесь, а страницы получают уже готовые дни и суммы.
 *
 * Арифметика НЕ дублируется: те же правила, что в balance.ts (единственный источник долга).
 * У второстепенного заработок дня — сумма снимков `Order.floristTotal` доставленных заказов
 * минус дополнительные расходы по ним; у основного — доля от прибыли ПОСЧИТАННЫХ дней
 * (`DayFinance.complete`), через общий `dayShareCents`. Сумма дней обязана сходиться с
 * «К выплате» до цента, иначе экран снова начнёт спорить сам с собой.
 *
 * Нижняя граница у обеих моделей — дата старта из гейта (`accrualGate`/`primaryShareGate`).
 * «За всё время» означает «всё, что система считает», а не «с начала времён».
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { DEFAULT_STORE_TZ, localDateStr } from "@/lib/tz";
import { dayShareCents } from "./dayCalc";
import { accrualGate, primaryShareGate } from "./config";
import { formatDayLong } from "./earningsFormat";

export type EarningDay = { day: string; cents: number; orders: number };
export type EarningOrder = { orderId: string; orderNumber: string; cents: number; adjusted: boolean };
export type EarningTotal = { cents: number; orders: number };

export type EarningsRange = { cents: number; orders: number; days: EarningDay[] };

export type PeriodKey = "today" | "yesterday" | "week" | "month" | "custom";

export type ResolvedPeriod = {
  key: PeriodKey;
  /** UTC-полночь первого дня периода включительно. */
  from: Date;
  /** UTC-полночь последнего дня периода ВКЛЮЧИТЕЛЬНО (не «до»). */
  to: Date;
  label: string;
  /** Период укладывается в один день — показываем сразу заказы, а не строки дней. */
  singleDay: boolean;
};

const DAY_MS = 86_400_000;

/** UTC-полночь календарного дня по строке YYYY-MM-DD. */
export function dayFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Ключ YYYY-MM-DD из UTC-полуночи. */
export function keyFromDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function isDayKey(v: string | undefined | null): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Границы быстрого периода. Чистая функция — без БД и без Prisma.
 *
 * «Сегодня» — календарный день магазина (DEFAULT_STORE_TZ), потому что и `Order.deliveryDate`,
 * и `DayFinance.day` хранят UTC-полночь ЛОКАЛЬНОГО дня. Пересчитывать эти поля через
 * таймзону нельзя — день съедет на сутки (см. CLAUDE.md).
 *
 * «Неделя» и «Месяц» — последние 7 дней и ТЕКУЩИЙ календарный месяц: владелец в ТЗ пишет
 * «Этот месяц», а не «последние 30 дней».
 */
export function resolvePeriod(
  key: string | undefined,
  custom: { from?: string; to?: string } = {},
  now: Date = new Date()
): ResolvedPeriod {
  const today = dayFromKey(localDateStr(now, DEFAULT_STORE_TZ));

  if (key === "custom" || (isDayKey(custom.from) && isDayKey(custom.to))) {
    if (isDayKey(custom.from) && isDayKey(custom.to)) {
      const from = dayFromKey(custom.from);
      const to = dayFromKey(custom.to);
      const [a, b] = from <= to ? [from, to] : [to, from];
      const single = +a === +b;
      // Подпись человеческая и в том же виде, что у строк дней ниже: «1 августа — 2 августа».
      const label = single ? formatDayLong(keyFromDay(a)) : `${formatDayLong(keyFromDay(a))} — ${formatDayLong(keyFromDay(b))}`;
      return { key: "custom", from: a, to: b, label, singleDay: single };
    }
  }

  if (key === "today") {
    return { key: "today", from: today, to: today, label: "Сегодня", singleDay: true };
  }
  if (key === "yesterday") {
    const y = new Date(+today - DAY_MS);
    return { key: "yesterday", from: y, to: y, label: "Вчера", singleDay: true };
  }
  if (key === "week") {
    return { key: "week", from: new Date(+today - 6 * DAY_MS), to: today, label: "Неделя", singleDay: false };
  }

  // По умолчанию — текущий месяц.
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return { key: "month", from: monthStart, to: today, label: "Этот месяц", singleDay: false };
}

/** Модель расчёта и её профиль. null — модель не задана, заработка нет. */
async function resolveModel(floristId: string, at: Date) {
  return prisma.floristFinanceProfile.findFirst({
    where: { floristId, active: true, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    select: { id: true, model: true, sharePercentBp: true },
  });
}

/** Нижняя граница выборки: позже из даты периода и даты старта гейта. */
function clampFrom(from: Date, startDate: Date): Date {
  return from > startDate ? from : startDate;
}

const EMPTY: EarningsRange = { cents: 0, orders: 0, days: [] };

/**
 * Заработок второстепенного по дням. Один заказ = один вклад: снимок `floristTotal` минус
 * дополнительные расходы по этому заказу. Отрицательным заказ не становится: у нуля тот же
 * смысл, что и в balance.ts — «цена не задана», а не «флорист должен».
 */
async function secondaryDays(floristId: string, from: Date, to: Date): Promise<EarningsRange> {
  const orders = await prisma.order.findMany({
    where: { currentFloristId: floristId, orderStatus: "DELIVERED", deliveryDate: { gte: from, lte: to } },
    select: { id: true, floristTotal: true, deliveryDate: true },
  });
  if (orders.length === 0) return EMPTY;

  const expenses = await prisma.orderAdditionalExpense.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
    _sum: { amountCents: true },
  });
  const spentByOrder = new Map(expenses.map((e) => [e.orderId, e._sum.amountCents ?? 0]));

  const byDay = new Map<string, EarningDay>();
  let cents = 0;
  for (const o of orders) {
    if (!o.deliveryDate) continue;
    const gross = Math.max(Math.round(toNumber(o.floristTotal) * 100), 0);
    const net = gross - (spentByOrder.get(o.id) ?? 0);
    const key = keyFromDay(o.deliveryDate);
    const row = byDay.get(key) ?? { day: key, cents: 0, orders: 0 };
    row.cents += net;
    row.orders += 1;
    byDay.set(key, row);
    cents += net;
  }

  return { cents, orders: orders.length, days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)) };
}

/** Заработок основного по дням: доля от прибыли посчитанных дней. Неполные дни не в счёт. */
async function primaryDays(profileId: string, bp: number | null, from: Date, to: Date): Promise<EarningsRange> {
  if (bp == null) return EMPTY;
  const rows = await prisma.dayFinance.findMany({
    where: { financeProfileId: profileId, complete: true, day: { gte: from, lte: to } },
    select: { day: true, distributableCents: true, ordersTotal: true },
    orderBy: { day: "desc" },
  });

  let cents = 0;
  let orders = 0;
  const days: EarningDay[] = [];
  for (const r of rows) {
    const share = dayShareCents(r.distributableCents, bp);
    cents += share;
    orders += r.ordersTotal;
    days.push({ day: keyFromDay(r.day), cents: share, orders: r.ordersTotal });
  }
  return { cents, orders, days };
}

/** Заработок за период, разбитый по дням. Обе модели, один ответ. */
export async function floristEarningsRange(floristId: string, from: Date, to: Date): Promise<EarningsRange> {
  const profile = await resolveModel(floristId, new Date());
  if (!profile) return EMPTY;

  if (profile.model === "PRIMARY") {
    const gate = primaryShareGate();
    if (!gate.enabled) return EMPTY;
    return primaryDays(profile.id, profile.sharePercentBp, clampFrom(from, gate.startDate), to);
  }

  const gate = accrualGate();
  if (!gate.enabled) return EMPTY;
  return secondaryDays(floristId, clampFrom(from, gate.startDate), to);
}

/**
 * Три числа для карточек: сегодня, этот месяц, всё время. «Всё время» — от даты старта
 * гейта до сегодняшнего дня.
 */
export async function floristEarningTotals(
  floristId: string,
  now: Date = new Date()
): Promise<{ today: EarningTotal; month: EarningTotal; allTime: EarningTotal }> {
  const today = resolvePeriod("today", {}, now);
  const month = resolvePeriod("month", {}, now);
  const [t, m, a] = await Promise.all([
    floristEarningsRange(floristId, today.from, today.to),
    floristEarningsRange(floristId, month.from, month.to),
    // Нижняя граница подрежется гейтом внутри — здесь просто «достаточно давно».
    floristEarningsRange(floristId, new Date(0), today.to),
  ]);
  const total = (r: EarningsRange): EarningTotal => ({ cents: r.cents, orders: r.orders });
  return { today: total(t), month: total(m), allTime: total(a) };
}

/**
 * Заказы одного дня со сложившимися суммами — для второстепенного флориста.
 * Основному вместо этого показывается разбор дня (readShareDayBreakdown): у него заработок
 * складывается из прибыли дня целиком, а не из отдельных заказов.
 */
export async function floristDayOrders(floristId: string, day: Date): Promise<{ orders: EarningOrder[]; totalCents: number }> {
  const orders = await prisma.order.findMany({
    where: { currentFloristId: floristId, orderStatus: "DELIVERED", deliveryDate: day },
    select: { id: true, orderNumber: true, floristTotal: true },
    orderBy: { orderNumber: "asc" },
  });
  if (orders.length === 0) return { orders: [], totalCents: 0 };

  const expenses = await prisma.orderAdditionalExpense.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
    _sum: { amountCents: true },
  });
  const spentByOrder = new Map(expenses.map((e) => [e.orderId, e._sum.amountCents ?? 0]));

  const rows: EarningOrder[] = orders.map((o) => {
    const spent = spentByOrder.get(o.id) ?? 0;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      cents: Math.max(Math.round(toNumber(o.floristTotal) * 100), 0) - spent,
      // Помечаем заказ, из которого вычли расход: без пометки итог выглядит арифметической ошибкой.
      adjusted: spent > 0,
    };
  });
  return { orders: rows, totalCents: rows.reduce((a, r) => a + r.cents, 0) };
}
