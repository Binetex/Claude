import "server-only";
/**
 * Представления расчёта доли: полное для владельца и разрешённое для флориста.
 *
 * Одна модель расчёта, два представления. Различие ровно одно и оно важное: владелец видит
 * происхождение комиссии (фактическая или расчётная) и свою налоговую политику, а флорист —
 * нет. В его представлении налог вычитается на 100% всегда, потому что база начисления
 * именно такая; процент реального налогового расхода наружу не уходит никогда.
 */
import { prisma } from "@/lib/db";
import { buildDayPlan, dayKey } from "./snapshot";
import { computeDayShare } from "./primaryShare";
import { primaryShareGate } from "./config";

export type ShareDayRow = {
  day: string;
  ordersTotal: number;
  ordersCalculable: number;
  blocked: boolean;
  blockers: string[];
  distributableCents: number;
  shareCents: number;
  /** Уже записанное начисление за этот день; null — ещё не начислено. */
  accruedCents: number | null;
  accrualEntryId: string | null;
};

/** Дни с даты запуска: что посчитано, что начислено, что заблокировано. */
export async function listShareDays(now: Date = new Date()): Promise<{
  startDate: Date | null;
  disabledReason: string | null;
  sharePercentBp: number | null;
  floristName: string | null;
  rows: ShareDayRow[];
}> {
  const gate = primaryShareGate();
  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, sharePercentBp: true, florist: { select: { user: { select: { name: true } } } } },
  });

  if (!gate.enabled || !profile) {
    return {
      startDate: gate.enabled ? gate.startDate : null,
      disabledReason: gate.enabled ? "Не задан профиль основного флориста." : gate.reason,
      sharePercentBp: profile?.sharePercentBp ?? null,
      floristName: profile?.florist.user.name ?? null,
      rows: [],
    };
  }

  const days = await prisma.order.findMany({
    where: {
      currentFloristId: profile.floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: gate.startDate, lte: now },
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "desc" },
  });

  const accruals = await prisma.ledgerEntry.findMany({
    where: { floristId: profile.floristId, type: "PRIMARY_FLORIST_SHARE", reversal: null },
    select: { id: true, amountCents: true, effectiveDate: true },
  });
  const accrualByDay = new Map(accruals.map((a) => [dayKey(a.effectiveDate), a]));

  const rows: ShareDayRow[] = [];
  for (const { deliveryDate } of days) {
    const plan = await buildDayPlan(profile.id, deliveryDate);
    const computed = await computeDayShare(profile.id, deliveryDate);
    if (!plan || !computed) continue;
    const accrual = accrualByDay.get(computed.day);
    rows.push({
      day: computed.day,
      ordersTotal: computed.ordersTotal,
      ordersCalculable: computed.ordersCalculable,
      blocked: computed.blocked,
      blockers: plan.result.blockers,
      distributableCents: computed.distributableCents,
      shareCents: computed.shareCents,
      accruedCents: accrual?.amountCents ?? null,
      accrualEntryId: accrual?.id ?? null,
    });
  }

  return {
    startDate: gate.startDate,
    disabledReason: null,
    sharePercentBp: profile.sharePercentBp,
    floristName: profile.florist.user.name,
    rows,
  };
}

export type ShareBreakdownLine = { label: string; cents: number; negative: boolean };

export type ShareDayBreakdown = {
  day: string;
  sharePercentBp: number | null;
  distributableCents: number;
  shareCents: number;
  lines: ShareBreakdownLine[];
  orders: Array<{
    orderId: string;
    orderNumber: string;
    siteShortName: string;
    flowerRevenueCents: number;
    allocatedFlowerCents: number;
    distributableCents: number;
    included: boolean;
  }>;
};

/**
 * Разбор дня по строкам расхода.
 *
 * `forOwner = false` — представление флориста: происхождение комиссии не показывается,
 * налог фигурирует как полный расход бизнеса. Никаких owner-only величин здесь нет и
 * появиться не должно.
 */
export async function getShareDayBreakdown(
  profileId: string,
  day: Date,
  forOwner: boolean
): Promise<ShareDayBreakdown | null> {
  const plan = await buildDayPlan(profileId, day);
  const computed = await computeDayShare(profileId, day);
  if (!plan || !computed) return null;

  const included = plan.result.orders.filter((o) => o.isCalculable);
  const sum = (pick: (o: (typeof included)[number]) => number) => included.reduce((a, o) => a + pick(o), 0);

  const estimatedFees = included.filter((o) => o.acquiringFeeSource === "ESTIMATED").length;
  const feeLabel = forOwner
    ? `Комиссия эквайринга${estimatedFees > 0 ? ` (расчётных: ${estimatedFees} из ${included.length})` : " (фактическая)"}`
    : "Комиссия эквайринга";

  const lines: ShareBreakdownLine[] = [
    { label: "Выручка заказов (товары + налог + доставка заказчика)", cents: sum((o) => o.grossRevenueCents), negative: false },
    { label: "Полный Tax Reserve", cents: sum((o) => o.taxCents), negative: true },
    { label: "Фактическая доставка", cents: sum((o) => o.deliveryActualCents), negative: true },
    { label: feeLabel, cents: sum((o) => o.acquiringFeeCents), negative: true },
    { label: "Закупка ваз и подарков", cents: sum((o) => o.vaseGiftCostCents), negative: true },
    { label: "Расходники", cents: sum((o) => o.consumablesCents), negative: true },
    { label: "Расходы на цветы за день", cents: sum((o) => o.allocatedFlowerCents), negative: true },
  ];

  return {
    day: computed.day,
    sharePercentBp: computed.sharePercentBp,
    distributableCents: computed.distributableCents,
    shareCents: computed.shareCents,
    lines,
    orders: plan.result.orders.map((o) => {
      const meta = plan.inputs.meta.get(o.orderId)!;
      return {
        orderId: o.orderId,
        orderNumber: meta.orderNumber,
        siteShortName: meta.siteShortName,
        flowerRevenueCents: o.flowerRevenueCents,
        allocatedFlowerCents: o.allocatedFlowerCents,
        distributableCents: o.distributableCents,
        included: o.isCalculable,
      };
    }),
  };
}

/** Профиль основного флориста по его floristId — для кабинета самого флориста. */
export async function primaryProfileForFlorist(floristId: string): Promise<{ id: string; sharePercentBp: number | null } | null> {
  const row = await prisma.floristFinanceProfile.findFirst({
    where: { floristId, model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, sharePercentBp: true },
  });
  return row;
}
