import "server-only";
/**
 * Чтение доли основного флориста из ОПУБЛИКОВАННОГО расчёта.
 *
 * Правило, ради которого модуль существует: на пути чтения источник истины — снимок,
 * а не живой пересчёт. Экран не собирает вход расчёта, не резолвит ставки, комиссии,
 * вазы и цветы и не строит планы дней. Он показывает то, что уже опубликовано, и то,
 * что уже проведено по книге.
 *
 * Почему так, а не «посчитать на лету»: живой пересчёт на историческом экране может
 * разойтись с начислением — настройки с тех пор могли смениться. Раньше страница именно
 * это и делала, поэтому показывала числа, которых нет ни в одном снимке.
 *
 * Второе следствие — цена. Прежний путь тратил ~60 SQL-запросов НА КАЖДЫЙ день. Здесь
 * число запросов постоянно и не зависит от размера страницы: агрегаты берутся пачкой.
 *
 * Живой `buildDayPlan` остаётся только на пути записи и в предпросмотре — там он и нужен.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { primaryShareCents } from "./calc";
import { primaryShareGate } from "./config";
import { dayKey } from "./snapshot";
import { PER_PAGE_OPTIONS } from "./sharePaging";

export { PER_PAGE_OPTIONS };

/**
 * Статус дня. Считается по опубликованным снимкам и книге — без пересчёта.
 *
 * STALE отдельно от ACCRUED намеренно: если состав дня изменился после начисления
 * (заказ переназначили, добавили расход), начисление какое-то время отстаёт. Раньше это
 * было не видно вовсе — страница показывала свежий пересчёт и молчала о том, что в книге
 * лежит другая сумма.
 */
export type ShareDayStatus = "NOT_CALCULATED" | "PARTIAL" | "READY" | "ACCRUED" | "STALE";

export type ShareDayRow = {
  day: string;
  ordersTotal: number;
  ordersCalculable: number;
  /** Сумма из опубликованных снимков. Ноль без снимков — это «не считали», а не «ноль». */
  distributableCents: number;
  /** Расчётная доля по опубликованному расчёту. */
  shareCents: number;
  /** Действующее начисление: сторнированные записи исключены. */
  accruedCents: number | null;
  hasSnapshots: boolean;
  openIssues: number;
  status: ShareDayStatus;
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
};


/** Действующий профиль основного флориста — единственный запрос профиля на страницу. */
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

/**
 * Страница дней. Ровно шесть запросов независимо от того, 20 дней на странице или 100.
 *
 * Цикла «день → запросы» здесь нет и быть не должно: именно он делал страницу
 * неоткрываемой на длинной истории.
 */
export async function listShareDaysRead(
  paging: { page: number; perPage: number },
  now: Date = new Date()
): Promise<ShareDaysPage> {
  const perPage = PER_PAGE_OPTIONS.includes(paging.perPage as (typeof PER_PAGE_OPTIONS)[number])
    ? paging.perPage
    : PER_PAGE_OPTIONS[0];
  const page = Math.max(paging.page, 1);

  const gate = primaryShareGate();
  const profile = await primaryProfile(); // 1

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
  };
  if (!gate.enabled || !profile) return empty;

  const floristId = profile.floristId;

  // 2 — сколько всего дней. Считается отдельно, чтобы не тянуть всю историю ради
  // первой страницы.
  const totalRows = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(DISTINCT o."deliveryDate")::int AS total
    FROM "Order" o
    WHERE o."currentFloristId" = ${floristId}
      AND o."orderStatus"::text = 'DELIVERED'
      AND o."deliveryDate" >= ${gate.startDate}
      AND o."deliveryDate" <= ${now}
  `;
  const totalDays = totalRows[0]?.total ?? 0;
  if (totalDays === 0) return { ...empty, disabledReason: null, totalDays: 0 };

  // 3 — сами дни страницы, новые сверху.
  const dayRows = await prisma.$queryRaw<{ day: Date }[]>`
    SELECT DISTINCT o."deliveryDate" AS day
    FROM "Order" o
    WHERE o."currentFloristId" = ${floristId}
      AND o."orderStatus"::text = 'DELIVERED'
      AND o."deliveryDate" >= ${gate.startDate}
      AND o."deliveryDate" <= ${now}
    ORDER BY o."deliveryDate" DESC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `;
  const days = dayRows.map((r) => r.day);
  if (days.length === 0) return { ...empty, disabledReason: null, totalDays };

  // 4 — агрегат опубликованных снимков по дням страницы, одним запросом.
  const agg = await prisma.$queryRaw<
    { day: Date; orders_total: number; snapshotted: number; calculable: number; distributable: number }[]
  >`
    SELECT o."deliveryDate" AS day,
           count(*)::int AS orders_total,
           count(s.id)::int AS snapshotted,
           count(s.id) FILTER (WHERE s."isCalculable")::int AS calculable,
           COALESCE(sum(s."distributableCents") FILTER (WHERE s."isCalculable"), 0)::int AS distributable
    FROM "Order" o
    LEFT JOIN "OrderFinancialSnapshot" s
      ON s."orderId" = o.id AND s.status::text = 'PUBLISHED'
    WHERE o."currentFloristId" = ${floristId}
      AND o."orderStatus"::text = 'DELIVERED'
      AND o."deliveryDate" IN (${Prisma.join(days)})
    GROUP BY o."deliveryDate"
  `;
  const aggByDay = new Map(agg.map((a) => [dayKey(a.day), a]));

  // 5 — действующие начисления. `reversal: null` и есть правило актуальности:
  // сторнированная запись перестаёт быть суммой дня, оставаясь в истории.
  const accruals = await prisma.ledgerEntry.findMany({
    where: {
      floristId,
      type: "PRIMARY_FLORIST_SHARE",
      effectiveDate: { in: days },
      reversal: null,
    },
    select: { amountCents: true, effectiveDate: true, metadata: true },
  });
  const accrualByDay = new Map<string, { cents: number; bp: number | null }>();
  for (const a of accruals) {
    const key = dayKey(a.effectiveDate);
    const prev = accrualByDay.get(key);
    const bp =
      a.metadata && typeof a.metadata === "object" && "sharePercentBp" in a.metadata
        ? Number((a.metadata as { sharePercentBp?: unknown }).sharePercentBp)
        : null;
    accrualByDay.set(key, { cents: (prev?.cents ?? 0) + a.amountCents, bp: prev?.bp ?? (Number.isFinite(bp) ? bp : null) });
  }

  // 6 — открытые проблемы: только для статуса дня, без разбора причин.
  const issues = await prisma.financeIssue.groupBy({
    by: ["scopeDate"],
    where: { status: "OPEN", scopeDate: { in: days } },
    _count: true,
  });
  const issuesByDay = new Map(
    issues.filter((i) => i.scopeDate != null).map((i) => [dayKey(i.scopeDate as Date), i._count])
  );

  const rows: ShareDayRow[] = days.map((d) => {
    const key = dayKey(d);
    const a = aggByDay.get(key);
    const accrual = accrualByDay.get(key) ?? null;
    const openIssues = issuesByDay.get(key) ?? 0;

    const ordersTotal = a?.orders_total ?? 0;
    const calculable = a?.calculable ?? 0;
    const snapshotted = a?.snapshotted ?? 0;
    const distributable = a?.distributable ?? 0;

    // Процент берётся из самого начисления, если оно есть: день, посчитанный по прежней
    // ставке, должен объясняться той ставкой, а не сегодняшней.
    const bp = accrual?.bp ?? profile.sharePercentBp ?? 0;
    const shareCents = primaryShareCents(distributable, bp);

    return {
      day: key,
      ordersTotal,
      ordersCalculable: calculable,
      distributableCents: distributable,
      shareCents,
      accruedCents: accrual?.cents ?? null,
      hasSnapshots: snapshotted > 0,
      openIssues,
      status: deriveStatus({ snapshotted, calculable, ordersTotal, accrued: accrual?.cents ?? null, shareCents }),
    };
  });

  return {
    startDate: gate.startDate,
    disabledReason: null,
    sharePercentBp: profile.sharePercentBp,
    floristName: profile.florist.user.name,
    profileId: profile.id,
    floristId,
    rows,
    page,
    perPage,
    totalDays,
  };
}

function deriveStatus(x: {
  snapshotted: number;
  calculable: number;
  ordersTotal: number;
  accrued: number | null;
  shareCents: number;
}): ShareDayStatus {
  if (x.snapshotted === 0) return "NOT_CALCULATED";
  if (x.accrued != null && x.accrued !== x.shareCents) return "STALE";
  if (x.accrued != null) return "ACCRUED";
  if (x.calculable < x.ordersTotal) return "PARTIAL";
  return "READY";
}

// ─────────────────────── Разбор одного дня ───────────────────────

export type ShareBreakdownLine = { label: string; cents: number; negative: boolean };

export type ShareDayDetail = {
  day: string;
  /** Нет опубликованных снимков — день ещё не рассчитывали. */
  calculated: boolean;
  sharePercentBp: number | null;
  distributableCents: number;
  shareCents: number;
  accruedCents: number | null;
  stale: boolean;
  lines: ShareBreakdownLine[];
  orders: Array<{
    orderId: string;
    orderNumber: string;
    siteShortName: string;
    flowerRevenueCents: number;
    allocatedFlowerCents: number;
    distributableCents: number;
    included: boolean;
    revision: number;
  }>;
};

/**
 * Разбор дня из опубликованных снимков. Ничего не пересчитывает и ничего не пишет.
 *
 * `forOwner = false` — представление флориста: происхождение комиссии не показывается.
 * Owner-only величин здесь нет и появиться не должно.
 */
export async function readShareDayBreakdown(
  profileId: string,
  day: Date,
  forOwner: boolean
): Promise<ShareDayDetail | null> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { floristId: true, sharePercentBp: true },
  });
  if (!profile) return null;

  const snapshots = await prisma.orderFinancialSnapshot.findMany({
    where: {
      status: "PUBLISHED",
      order: { deliveryDate: day, currentFloristId: profile.floristId, orderStatus: "DELIVERED" },
    },
    select: {
      orderId: true,
      revision: true,
      isCalculable: true,
      grossRevenueCents: true,
      tipsCents: true,
      taxCents: true,
      deliveryActualCents: true,
      acquiringFeeCents: true,
      acquiringFeeSource: true,
      vaseGiftCostCents: true,
      consumablesCents: true,
      allocatedFlowerCents: true,
      otherExpenseCents: true,
      distributableCents: true,
      flowerRevenueCents: true,
      order: { select: { orderNumber: true, site: { select: { shortName: true } } } },
    },
    orderBy: { revision: "asc" },
  });

  const accrual = await prisma.ledgerEntry.findFirst({
    where: { floristId: profile.floristId, type: "PRIMARY_FLORIST_SHARE", effectiveDate: day, reversal: null },
    select: { amountCents: true, metadata: true },
  });

  if (snapshots.length === 0) {
    return {
      day: dayKey(day),
      calculated: false,
      sharePercentBp: profile.sharePercentBp,
      distributableCents: 0,
      shareCents: 0,
      accruedCents: accrual?.amountCents ?? null,
      stale: false,
      lines: [],
      orders: [],
    };
  }

  const included = snapshots.filter((s) => s.isCalculable);
  const sum = (pick: (s: (typeof included)[number]) => number) => included.reduce((a, s) => a + pick(s), 0);

  const estimatedFees = included.filter((s) => s.acquiringFeeSource === "ESTIMATED").length;
  const feeLabel = forOwner
    ? `Комиссия эквайринга${estimatedFees > 0 ? ` (расчётных: ${estimatedFees} из ${included.length})` : " (фактическая)"}`
    : "Комиссия эквайринга";

  const lines: ShareBreakdownLine[] = [
    { label: "Получено от клиентов (товары + налог + доставка + чаевые)", cents: sum((s) => s.grossRevenueCents), negative: false },
    { label: "Чаевые (принадлежат владельцу)", cents: sum((s) => s.tipsCents), negative: true },
    { label: "Полный Tax Reserve", cents: sum((s) => s.taxCents), negative: true },
    { label: "Фактическая доставка", cents: sum((s) => s.deliveryActualCents), negative: true },
    { label: feeLabel, cents: sum((s) => s.acquiringFeeCents), negative: true },
    { label: "Закупка ваз и подарков", cents: sum((s) => s.vaseGiftCostCents), negative: true },
    { label: "Расходники", cents: sum((s) => s.consumablesCents), negative: true },
    { label: "Расходы на цветы за день", cents: sum((s) => s.allocatedFlowerCents), negative: true },
  ];
  const additional = sum((s) => s.otherExpenseCents);
  if (additional > 0) lines.push({ label: "Дополнительные расходы", cents: additional, negative: true });

  const distributableCents = sum((s) => s.distributableCents);
  const bp =
    (accrual?.metadata && typeof accrual.metadata === "object" && "sharePercentBp" in accrual.metadata
      ? Number((accrual.metadata as { sharePercentBp?: unknown }).sharePercentBp)
      : null) ?? profile.sharePercentBp ?? 0;
  const shareCents = primaryShareCents(distributableCents, bp);

  return {
    day: dayKey(day),
    calculated: true,
    sharePercentBp: bp,
    distributableCents,
    shareCents,
    accruedCents: accrual?.amountCents ?? null,
    stale: accrual != null && accrual.amountCents !== shareCents,
    lines,
    orders: snapshots.map((s) => ({
      orderId: s.orderId,
      orderNumber: s.order.orderNumber,
      siteShortName: s.order.site.shortName,
      flowerRevenueCents: s.flowerRevenueCents,
      allocatedFlowerCents: s.allocatedFlowerCents,
      distributableCents: s.distributableCents,
      included: s.isCalculable,
      revision: s.revision,
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
