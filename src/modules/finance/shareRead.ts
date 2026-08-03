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
import { primaryShareGate } from "./config";
import { dayKey } from "./dayFinance";
import { PER_PAGE_OPTIONS } from "./sharePaging";

export { PER_PAGE_OPTIONS };

/**
 * Состояние дня.
 *
 * NOT_CALCULATED — строки нет: день ещё не считали.
 * INCOMPLETE — считали, но заполнены не все заказы: доли нет по построению.
 * COUNTED — посчитан целиком, доля входит в долг.
 */
export type ShareDayStatus = "NOT_CALCULATED" | "INCOMPLETE" | "COUNTED";

export type ShareDayRow = {
  day: string;
  status: ShareDayStatus;
  ordersTotal: number;
  distributableCents: number;
  shareCents: number;
  blockers: string[];
  openIssues: number;
};

export type ShareDaysPage = {
  startDate: Date | null;
  disabledReason: string | null;
  sharePercentBp: number | null;
  floristName: string | null;
  profileId: string | null;
  floristId: string | null;
  rows: ShareDayRow[];
  page: number;
  perPage: number;
  totalDays: number;
  /** Сумма долей посчитанных дней страницы. */
  pageShareCents: number;
};

async function primaryProfile() {
  return prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: {
      id: true,
      floristId: true,
      sharePercentBp: true,
      florist: { select: { user: { select: { name: true } } } },
    },
  });
}

/** Страница дней. Число запросов постоянно: строки уже посчитаны, их только читают. */
export async function listShareDaysRead(
  paging: { page: number; perPage: number },
  now: Date = new Date()
): Promise<ShareDaysPage> {
  const perPage = PER_PAGE_OPTIONS.includes(paging.perPage as (typeof PER_PAGE_OPTIONS)[number])
    ? paging.perPage
    : PER_PAGE_OPTIONS[0];
  const page = Math.max(paging.page, 1);

  const gate = primaryShareGate();
  const profile = await primaryProfile();

  const empty: ShareDaysPage = {
    startDate: gate.enabled ? gate.startDate : null,
    disabledReason: gate.enabled ? "Не задан профиль основного флориста." : gate.reason,
    sharePercentBp: profile?.sharePercentBp ?? null,
    floristName: profile?.florist.user.name ?? null,
    profileId: profile?.id ?? null,
    floristId: profile?.floristId ?? null,
    rows: [],
    page,
    perPage,
    totalDays: 0,
    pageShareCents: 0,
  };
  if (!gate.enabled || !profile) return empty;

  const where = { financeProfileId: profile.id, day: { gte: gate.startDate, lte: now } };

  const [totalDays, rows] = await Promise.all([
    prisma.dayFinance.count({ where }),
    prisma.dayFinance.findMany({
      where,
      orderBy: { day: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: { day: true, complete: true, blockers: true, ordersTotal: true, distributableCents: true },
    }),
  ]);

  const issues = rows.length
    ? await prisma.financeIssue.groupBy({
        by: ["scopeDate"],
        where: { status: "OPEN", scopeDate: { in: rows.map((r) => r.day) } },
        _count: true,
      })
    : [];
  const issuesByDay = new Map(
    issues.filter((i) => i.scopeDate != null).map((i) => [dayKey(i.scopeDate as Date), i._count])
  );

  const bp = profile.sharePercentBp ?? 0;
  const mapped: ShareDayRow[] = rows.map((r) => ({
    day: dayKey(r.day),
    status: r.complete ? "COUNTED" : "INCOMPLETE",
    ordersTotal: r.ordersTotal,
    distributableCents: r.distributableCents,
    shareCents: r.complete ? dayShareCents(r.distributableCents, bp) : 0,
    blockers: r.blockers,
    openIssues: issuesByDay.get(dayKey(r.day)) ?? 0,
  }));

  return {
    ...empty,
    disabledReason: null,
    rows: mapped,
    totalDays,
    pageShareCents: mapped.reduce((a, r) => a + r.shareCents, 0),
  };
}

// ─────────────────────── Разбор одного дня ───────────────────────

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
 * Представления владельца и флориста теперь совпадают: единственным различием было
 * происхождение комиссии (фактическая или расчётная), а оно относилось к позаказному
 * снимку и в дневной строке не хранится. Параметр оставлен, чтобы не переписывать вызовы;
 * если различий так и не появится — уйдёт.
 */
export async function readShareDayBreakdown(
  profileId: string,
  day: Date,
  _forOwner: boolean
): Promise<ShareDayDetail | null> {
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
