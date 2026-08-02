import "server-only";
/**
 * Предпросмотр исправления: что изменится, если применить кандидатское значение.
 *
 * Считает ТЕМ ЖЕ кодом, что и публикация (`buildDayPlan` с overrides), поэтому показанное
 * владельцу число не может разойтись с тем, что запишется. Не пишет ничего.
 */
import { prisma } from "@/lib/db";
import { buildDayPlan, dayKey, type CalcOverrides } from "./snapshot";
import { primaryShareCents } from "./calc";

export type PreviewOrderLine = {
  orderId: string;
  orderNumber: string;
  siteShortName: string;
  flowerRevenueCents: number;
  allocatedBeforeCents: number;
  allocatedAfterCents: number;
  distributableBeforeCents: number;
  distributableAfterCents: number;
  calculableBefore: boolean;
  calculableAfter: boolean;
};

export type DayPreview = {
  day: string;
  ordersTotal: number;
  /** Сколько заказов дня войдёт в расчёт до и после исправления. */
  calculableBefore: number;
  calculableAfter: number;
  dailyExpenseCents: number | null;
  denominatorCents: number;
  allocatedBeforeCents: number;
  allocatedAfterCents: number;
  unallocatedBeforeCents: number;
  unallocatedAfterCents: number;
  distributableBeforeCents: number;
  distributableAfterCents: number;
  /** Доля основного флориста за день. NULL — процент ещё не задан (Stage 3b). */
  shareBeforeCents: number | null;
  shareAfterCents: number | null;
  lines: PreviewOrderLine[];
};

/**
 * Эффект кандидатского значения на день. `sharePercentBp` берётся из профиля; пока он
 * не задан, доля показывается как «неизвестно», а не как ноль — на Stage 3a начислений
 * ещё нет, и обещать конкретную сумму было бы враньём.
 */
export async function previewDay(
  profileId: string,
  day: Date,
  overrides: CalcOverrides = {}
): Promise<DayPreview | null> {
  const [before, after] = await Promise.all([buildDayPlan(profileId, day), buildDayPlan(profileId, day, overrides)]);
  if (!before || !after) return null;

  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { sharePercentBp: true },
  });
  const bp = profile?.sharePercentBp ?? null;

  const lines: PreviewOrderLine[] = after.result.orders.map((a) => {
    const b = before.result.orders.find((x) => x.orderId === a.orderId)!;
    const meta = after.inputs.meta.get(a.orderId)!;
    return {
      orderId: a.orderId,
      orderNumber: meta.orderNumber,
      siteShortName: meta.siteShortName,
      flowerRevenueCents: a.flowerRevenueCents,
      allocatedBeforeCents: b.allocatedFlowerCents,
      allocatedAfterCents: a.allocatedFlowerCents,
      distributableBeforeCents: b.distributableCents,
      distributableAfterCents: a.distributableCents,
      calculableBefore: b.isCalculable,
      calculableAfter: a.isCalculable,
    };
  });

  return {
    day: dayKey(day),
    ordersTotal: after.result.orders.length,
    calculableBefore: before.result.orders.filter((o) => o.isCalculable).length,
    calculableAfter: after.result.orders.filter((o) => o.isCalculable).length,
    dailyExpenseCents: after.result.dailyExpenseCents,
    denominatorCents: after.result.denominatorCents,
    allocatedBeforeCents: before.result.allocatedCents,
    allocatedAfterCents: after.result.allocatedCents,
    unallocatedBeforeCents: before.result.unallocatedCents,
    unallocatedAfterCents: after.result.unallocatedCents,
    distributableBeforeCents: before.result.distributableTotalCents,
    distributableAfterCents: after.result.distributableTotalCents,
    shareBeforeCents: bp == null ? null : primaryShareCents(before.result.distributableTotalCents, bp),
    shareAfterCents: bp == null ? null : primaryShareCents(after.result.distributableTotalCents, bp),
    lines,
  };
}

/**
 * Дни, затронутые изменением настройки магазина (модель комиссии, ставка расходников).
 * Нужен предпросмотру массового действия: владелец должен видеть, сколько заказов
 * изменится, ДО записи.
 */
export async function daysAffectedBySite(profileId: string, siteId: string, from: Date, to: Date): Promise<Date[]> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { floristId: true },
  });
  if (!profile) return [];
  const rows = await prisma.order.findMany({
    where: {
      siteId,
      currentFloristId: profile.floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: from, lte: to },
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "asc" },
  });
  return rows.map((r) => r.deliveryDate);
}

/** Средняя дневная закупка за последние N дней — предложение для пустого дня. */
export async function suggestDailyExpenseCents(profileId: string, day: Date, lookbackDays = 7): Promise<number | null> {
  const from = new Date(day.getTime() - lookbackDays * 86400_000);
  const rows = await prisma.dailyFlowerExpense.findMany({
    where: { financeProfileId: profileId, expenseDay: { gte: from, lt: day } },
    select: { amountCents: true },
  });
  if (rows.length === 0) return null;
  return Math.round(rows.reduce((a, r) => a + r.amountCents, 0) / rows.length);
}

/**
 * Предложение по фактической доставке: стоимость из записи Burq, если она есть.
 * Ничего не выдумывает — при отсутствии данных возвращает null, и владелец вводит сам.
 */
export async function suggestDeliveryCostCents(orderId: string): Promise<{ cents: number; source: string } | null> {
  const delivery = await prisma.delivery.findFirst({
    where: { orderId, OR: [{ finalCost: { not: null } }, { quoteAmount: { not: null } }] },
    orderBy: { createdAt: "desc" },
    select: { finalCost: true, quoteAmount: true, costSource: true },
  });
  if (!delivery) return null;
  // Фактическая стоимость приоритетнее котировки: котировка — это оценка до доставки.
  if (delivery.finalCost != null) {
    return { cents: Math.round(Number(delivery.finalCost) * 100), source: delivery.costSource ?? "BURQ_FINAL" };
  }
  return { cents: Math.round(Number(delivery.quoteAmount) * 100), source: "BURQ_QUOTE" };
}
