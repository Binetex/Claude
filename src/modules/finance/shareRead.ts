import "server-only";
/**
 * Чтение доли основного флориста.
 *
 * Источник один — строка `DayFinance`. Ни живого пересчёта, ни агрегатов по позаказным
 * снимкам, ни сверки с книгой: долг выводится из этих же строк, поэтому расходиться
 * нечему. Вместе с расхождением исчезли и статусы, которые его описывали, — «требует
 * пересчёта» и «начислено иначе».
 *
 * Число запросов постоянно и не зависит от размера страницы.
 */
import { prisma } from "@/lib/db";
import { dayShareCents } from "./dayCalc";
import { dayKey } from "./dayFinance";


export type ShareBreakdownLine = { label: string; cents: number; negative: boolean };

export type ShareDayDetail = {
  day: string;
  calculated: boolean;
  complete: boolean;
  sharePercentBp: number | null;
  distributableCents: number;
  shareCents: number;
  blockers: string[];
  lines: ShareBreakdownLine[];
  orders: Array<{ orderId: string; orderNumber: string; contributionCents: number; missing: string[] }>;
};

/**
 * Разбор дня из его строки. Ничего не считает и не пишет.
 *
 * Представления владельца и флориста совпадают: единственным различием было
 * происхождение комиссии (фактическая или расчётная), а оно относилось к позаказному
 * снимку, которого больше нет. Разных версий этого экрана не существует.
 */
export async function readShareDayBreakdown(profileId: string, day: Date): Promise<ShareDayDetail | null> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { sharePercentBp: true },
  });
  if (!profile) return null;

  const row = await prisma.dayFinance.findUnique({
    where: { financeProfileId_day: { financeProfileId: profileId, day } },
  });

  const bp = profile.sharePercentBp;
  if (!row) {
    return {
      day: dayKey(day),
      calculated: false,
      complete: false,
      sharePercentBp: bp,
      distributableCents: 0,
      shareCents: 0,
      blockers: [],
      lines: [],
      orders: [],
    };
  }

  const lines: ShareBreakdownLine[] = [
    { label: "Получено от клиентов (товары + налог + доставка + чаевые)", cents: row.grossRevenueCents, negative: false },
    { label: "Чаевые (принадлежат владельцу)", cents: row.tipsCents, negative: true },
    { label: "Полный Tax Reserve", cents: row.taxCents, negative: true },
    { label: "Фактическая доставка", cents: row.deliveryCents, negative: true },
    { label: "Комиссия эквайринга", cents: row.acquiringFeeCents, negative: true },
    { label: "Закупка ваз и подарков", cents: row.vaseGiftCostCents, negative: true },
    { label: "Расходники", cents: row.consumablesCents, negative: true },
    { label: "Расходы на цветы за день", cents: row.flowerPurchaseCents, negative: true },
  ];
  if (row.additionalCents > 0) {
    lines.push({ label: "Дополнительные расходы", cents: row.additionalCents, negative: true });
  }

  const orders =
    (row.ordersJson as unknown as Array<{
      orderId: string;
      orderNumber: string;
      contributionCents: number;
      missing: string[];
    }>) ?? [];

  return {
    day: dayKey(day),
    calculated: true,
    complete: row.complete,
    sharePercentBp: bp,
    distributableCents: row.distributableCents,
    shareCents: row.complete ? dayShareCents(row.distributableCents, bp ?? 0) : 0,
    blockers: row.blockers,
    lines,
    orders: orders.map((o) => ({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      contributionCents: o.contributionCents,
      missing: o.missing ?? [],
    })),
  };
}

/** Профиль основного флориста по floristId — для его собственного кабинета. */
export async function primaryProfileForFlorist(
  floristId: string
): Promise<{ id: string; sharePercentBp: number | null } | null> {
  return prisma.floristFinanceProfile.findFirst({
    where: { floristId, model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, sharePercentBp: true },
  });
}
