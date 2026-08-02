import "server-only";
/**
 * Применение исправлений из Finance Setup Assistant.
 *
 * Ассистент НЕ пишет деньги. Он пишет только входные данные расчёта — стоимость вазы,
 * дневную закупку, модель комиссии, — а начисление после этого делает отдельный
 * гейтованный конвейер. На Stage 3a начислений нет вовсе: `LedgerEntry` этот модуль
 * не создаёт ни одной строкой.
 *
 * Порядок после любой записи одинаков и нарушать его нельзя:
 *   настройка → аудит → новая ревизия снимков затронутых дней → детектор.
 * Аудит пишут сами сервисы настроек (settings.ts, setVasePurchaseCost, vaseLink), поэтому
 * второй раз он здесь не дублируется — иначе одна операция дала бы две записи истории.
 */
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { setVasePurchaseCost } from "@/modules/catalog/finance/setVasePurchaseCost";
import { setVariantVase, type VaseSelection } from "@/modules/catalog/finance/vaseLink";
import { detectFinanceIssues, DETECTOR_WINDOW_DAYS } from "./issues";
import { publishDaySnapshots } from "./snapshot";
import { setConsumablesRate, setDailyFlowerExpense, setFeeModel, setOwnerTaxPolicy } from "./settings";

export type FixActor = { userId: string; role: Role };

export class FinanceFixError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "FinanceFixError";
  }
}

function assertOwner(actor: FixActor): void {
  if (actor.role !== "OWNER") {
    throw new FinanceFixError("forbidden", "Исправления доступны только владельцу.");
  }
}

export type FixResult = {
  /** Сколько ревизий снимков опубликовано. */
  republished: number;
  /** Сколько дней пересчитано. */
  days: number;
  /** Итог прогона детектора. */
  detector: { opened: number; updated: number; autoResolved: number };
};

/** Действующий профиль основного флориста. Без него считать нечего. */
async function primaryProfile(): Promise<{ id: string; floristId: string } | null> {
  return prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true },
  });
}

function windowStart(now: Date): Date {
  return new Date(now.getTime() - DETECTOR_WINDOW_DAYS * 86400_000);
}

/** Дни доставки заказов основного флориста, попадающие под фильтр. */
async function daysFor(
  floristId: string,
  where: { orderId?: string; siteId?: string; variantId?: string; day?: Date },
  now: Date
): Promise<Date[]> {
  if (where.day) return [where.day];
  const rows = await prisma.order.findMany({
    where: {
      currentFloristId: floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: windowStart(now), lte: now },
      ...(where.orderId ? { id: where.orderId } : {}),
      ...(where.siteId ? { siteId: where.siteId } : {}),
      ...(where.variantId ? { items: { some: { variantId: where.variantId } } } : {}),
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "asc" },
  });
  return rows.map((r) => r.deliveryDate);
}

/**
 * Общий хвост любого исправления: пересобрать снимки затронутых дней и прогнать детектор.
 * Публикация ревизий идёт по дням, а не по заказам: распределение закупки общее для дня,
 * и пересчитать один заказ в отрыве от остальных нельзя.
 */
async function republishAndDetect(
  profileId: string,
  days: Date[],
  actor: FixActor,
  now: Date
): Promise<FixResult> {
  let republished = 0;
  for (const day of days) {
    const { published } = await publishDaySnapshots(profileId, day, actor);
    republished += published;
  }
  const detector = await detectFinanceIssues(now);
  return { republished, days: days.length, detector: { opened: detector.opened, updated: detector.updated, autoResolved: detector.autoResolved } };
}

/** Помечает проблему разобранной. Детектор её потом не переоткроет. */
async function resolveIssue(issueId: string | null, actor: FixActor, comment: string | null): Promise<void> {
  if (!issueId) return;
  const issue = await prisma.financeIssue.findUnique({ where: { id: issueId }, select: { status: true } });
  if (!issue || issue.status !== "OPEN") return;
  await prisma.financeIssue.update({
    where: { id: issueId },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor.userId, resolutionComment: comment },
  });
}

// ─────────────────────── 1. Фактическая доставка ───────────────────────

/**
 * Подтверждает фактическую стоимость доставки по заказу. Ноль — валидное подтверждение
 * (самовывоз), поэтому пишется отметка подтверждения: без неё ноль неотличим от «неизвестно».
 */
export async function fixDeliveryActualCost(args: {
  orderId: string;
  amountCents: number;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  if (!Number.isInteger(args.amountCents) || args.amountCents < 0) {
    throw new FinanceFixError("bad_amount", "Стоимость доставки должна быть целым неотрицательным числом.");
  }
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, deliveryActualCost: true, currentFloristId: true },
  });
  if (!order) throw new FinanceFixError("order_not_found", "Заказ не найден.");

  const now = args.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: args.orderId },
      data: { deliveryActualCost: (args.amountCents / 100).toFixed(2), deliveryActualCostConfirmedAt: now },
    });
    await tx.financeAudit.create({
      data: {
        entity: "Order",
        entityId: args.orderId,
        action: "SET_DELIVERY_ACTUAL_COST",
        beforeJson: { deliveryActualCost: order.deliveryActualCost.toString() },
        afterJson: { deliveryActualCostCents: args.amountCents, confirmedAt: now.toISOString() },
        reason: args.comment ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });

  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  const days = await daysFor(profile.floristId, { orderId: args.orderId }, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ─────────────────────── 2. Модель комиссии магазина ───────────────────────

export async function fixSiteFeeModel(args: {
  siteId: string;
  percentBp: number;
  fixedCents: number;
  effectiveFrom: Date;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  await setFeeModel({
    siteId: args.siteId,
    percentBp: args.percentBp,
    fixedCents: args.fixedCents,
    effectiveFrom: args.effectiveFrom,
    comment: args.comment ?? null,
    actor: args.actor,
  });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  const days = await daysFor(profile.floristId, { siteId: args.siteId }, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ─────────────────────── 3. Дневная закупка цветов ───────────────────────

export async function fixDailyFlowerExpense(args: {
  expenseDay: Date;
  amountCents: number;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  await setDailyFlowerExpense({
    financeProfileId: profile.id,
    expenseDay: args.expenseDay,
    amountCents: args.amountCents,
    comment: args.comment ?? null,
    actor: args.actor,
  });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  return republishAndDetect(profile.id, [args.expenseDay], args.actor, now);
}

// ─────────────────── 4. Закупочная стоимость вазы/подарка ───────────────────

export async function fixVasePurchaseCost(args: {
  variantId: string;
  amountCents: number;
  effectiveFrom: Date;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  const variant = await prisma.productVariant.findUnique({
    where: { id: args.variantId },
    select: { id: true, title: true, product: { select: { name: true, site: { select: { shortName: true } } } } },
  });
  if (!variant) throw new FinanceFixError("variant_not_found", "Товар не найден.");

  await setVasePurchaseCost({
    target: { productVariantId: args.variantId },
    // Стоимость задаётся у самой позиции: STANDALONE_VASE — «эта позиция и есть ваза/подарок».
    costType: "STANDALONE_VASE",
    purchaseCostCents: args.amountCents,
    effectiveFrom: args.effectiveFrom,
    comment: args.comment ?? undefined,
    entityNameSnapshot: `${variant.product.name} — ${variant.title}`,
    siteShortNameSnapshot: variant.product.site.shortName,
    actor: args.actor,
  });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  const days = await daysFor(profile.floristId, { variantId: args.variantId }, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ─────────────────────── 5. Привязка вазы к букету ───────────────────────

/**
 * Связывает вариант-букет с реальным вариантом-вазой. Эвристика похожих ваз только
 * ПРЕДЛАГАЕТ варианты в интерфейсе — сам выбор всегда делает владелец, и массовая
 * привязка требует явно выбранной вазы.
 */
export async function fixVaseLink(args: {
  variantId: string;
  selection: VaseSelection;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  await setVariantVase({ variantId: args.variantId, selection: args.selection, actor: args.actor, reason: args.comment ?? undefined });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  const days = await daysFor(profile.floristId, { variantId: args.variantId }, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ─────────────────────── 6. Ставка расходников ───────────────────────

export async function fixConsumablesRate(args: {
  siteId: string | null;
  amountCents: number;
  effectiveFrom: Date;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  await setConsumablesRate({
    siteId: args.siteId,
    amountCents: args.amountCents,
    effectiveFrom: args.effectiveFrom,
    comment: args.comment ?? null,
    actor: args.actor,
  });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  const days = await daysFor(profile.floristId, args.siteId ? { siteId: args.siteId } : {}, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ─────────────────── 7. Налоговая политика владельца ───────────────────

export async function fixOwnerTaxPolicy(args: {
  siteId: string | null;
  actualShareBp: number;
  effectiveFrom: Date;
  issueId?: string | null;
  comment?: string | null;
  actor: FixActor;
  now?: Date;
}): Promise<FixResult> {
  assertOwner(args.actor);
  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  await setOwnerTaxPolicy({
    siteId: args.siteId,
    actualShareBp: args.actualShareBp,
    effectiveFrom: args.effectiveFrom,
    comment: args.comment ?? null,
    actor: args.actor,
  });

  const now = args.now ?? new Date();
  await resolveIssue(args.issueId ?? null, args.actor, args.comment ?? null);
  // База флориста от политики не зависит (в ней налог всегда 100%), но ссылка на
  // применённую политику обязана попасть в снимок — иначе расчёт владельца не объяснить.
  const days = await daysFor(profile.floristId, args.siteId ? { siteId: args.siteId } : {}, now);
  return republishAndDetect(profile.id, days, args.actor, now);
}

// ───────── Массовое подтверждение доставки по суммам Burq ─────────

export type BurqDeliveryCandidate = {
  orderId: string;
  orderNumber: string;
  siteShortName: string;
  deliveryDay: string;
  /** Сумма из записи доставки. */
  burqCents: number;
  /** Фактическая стоимость курьера либо котировка до доставки. */
  burqSource: "FINAL" | "QUOTE";
  /** Что сейчас стоит в заказе (может быть 0 — «неизвестно»). */
  currentCents: number;
};

/**
 * Заказы, у которых стоимость доставки не подтверждена, но сумма Burq уже есть.
 *
 * Заказы без суммы Burq сюда НЕ попадают: подставлять им общее значение значило бы
 * придумать данные, а у каждой доставки цена своя.
 */
export async function listBurqDeliveryCandidates(now: Date = new Date()): Promise<BurqDeliveryCandidate[]> {
  const profile = await primaryProfile();
  if (!profile) return [];

  const orders = await prisma.order.findMany({
    where: {
      currentFloristId: profile.floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: windowStart(now), lte: now },
      deliveryActualCostConfirmedAt: null,
      deliveryActualCost: 0,
      deliveries: { some: { OR: [{ finalCost: { not: null } }, { quoteAmount: { not: null } }] } },
    },
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      deliveryActualCost: true,
      site: { select: { shortName: true } },
      deliveries: {
        where: { OR: [{ finalCost: { not: null } }, { quoteAmount: { not: null } }] },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { finalCost: true, quoteAmount: true },
      },
    },
    orderBy: { deliveryDate: "desc" },
  });

  return orders.flatMap((o) => {
    const d = o.deliveries[0];
    if (!d) return [];
    // Факт приоритетнее котировки: котировка — оценка ДО доставки, и владелец должен
    // видеть, что именно он подтверждает.
    const final = d.finalCost != null ? Math.round(Number(d.finalCost) * 100) : null;
    const quote = d.quoteAmount != null ? Math.round(Number(d.quoteAmount) * 100) : null;
    const burqCents = final ?? quote;
    if (burqCents == null) return [];
    return [
      {
        orderId: o.id,
        orderNumber: o.orderNumber,
        siteShortName: o.site.shortName,
        deliveryDay: o.deliveryDate.toISOString().slice(0, 10),
        burqCents,
        burqSource: final != null ? ("FINAL" as const) : ("QUOTE" as const),
        currentCents: Math.round(Number(o.deliveryActualCost) * 100),
      },
    ];
  });
}

export type BulkDeliveryPreview = {
  orders: number;
  totalCents: number;
  days: string[];
  finalCount: number;
  quoteCount: number;
};

/** Что будет применено. Ничего не пишет. */
export async function previewBurqDeliveryConfirmation(orderIds: string[]): Promise<BulkDeliveryPreview> {
  const all = await listBurqDeliveryCandidates();
  const chosen = all.filter((c) => orderIds.includes(c.orderId));
  return {
    orders: chosen.length,
    totalCents: chosen.reduce((a, c) => a + c.burqCents, 0),
    days: [...new Set(chosen.map((c) => c.deliveryDay))].sort(),
    finalCount: chosen.filter((c) => c.burqSource === "FINAL").length,
    quoteCount: chosen.filter((c) => c.burqSource === "QUOTE").length,
  };
}

/**
 * Подтверждает стоимость доставки выбранным заказам.
 *
 * Каждому заказу — СВОЯ запись и СВОЙ FinanceAudit: массовость здесь только в том, что
 * владелец нажал одну кнопку, а не в том, что операция общая. Снимки пересобираются по
 * затронутым дням один раз, детектор — тоже один раз: гонять их на каждый из десятков
 * заказов бессмысленно и долго.
 *
 * Суммы берутся ТОЛЬКО из записи Burq выбранного заказа — никаких общих значений.
 */
export async function confirmBurqDeliveryCosts(args: {
  orderIds: string[];
  actor: FixActor;
  comment?: string | null;
  now?: Date;
}): Promise<FixResult & { confirmed: number }> {
  assertOwner(args.actor);
  if (args.orderIds.length === 0) throw new FinanceFixError("nothing_selected", "Выберите хотя бы один заказ.");

  const profile = await primaryProfile();
  if (!profile) throw new FinanceFixError("no_profile", "Не задан профиль основного флориста.");

  const now = args.now ?? new Date();
  const candidates = (await listBurqDeliveryCandidates(now)).filter((c) => args.orderIds.includes(c.orderId));
  if (candidates.length === 0) {
    throw new FinanceFixError("nothing_applicable", "Ни у одного из выбранных заказов нет суммы Burq.");
  }

  const batchId = `burq-delivery-${now.toISOString()}`;
  for (const c of candidates) {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: c.orderId },
        data: {
          deliveryActualCost: (c.burqCents / 100).toFixed(2),
          deliveryActualCostConfirmedAt: now,
        },
      });
      await tx.financeAudit.create({
        data: {
          entity: "Order",
          entityId: c.orderId,
          action: "SET_DELIVERY_ACTUAL_COST",
          beforeJson: { deliveryActualCostCents: c.currentCents, confirmed: false },
          afterJson: {
            deliveryActualCostCents: c.burqCents,
            source: c.burqSource === "FINAL" ? "BURQ_FINAL" : "BURQ_QUOTE",
            confirmedAt: now.toISOString(),
          },
          reason: args.comment ?? "Массовое подтверждение сумм Burq",
          batchId,
          entityNameSnapshot: c.orderNumber,
          siteShortNameSnapshot: c.siteShortName,
          userId: args.actor.userId,
          role: args.actor.role,
        },
      });
    });
  }

  // Закрываем связанные проблемы: детектор закрыл бы их и сам, но так владелец видит
  // именно «разобрано вручную», а не «исчезло само».
  await prisma.financeIssue.updateMany({
    where: { status: "OPEN", type: "DELIVERY_ACTUAL_COST_MISSING", orderId: { in: candidates.map((c) => c.orderId) } },
    data: {
      status: "RESOLVED",
      resolvedAt: now,
      resolvedBy: args.actor.userId,
      resolutionComment: args.comment ?? "Массовое подтверждение сумм Burq",
    },
  });

  const days = [...new Map(candidates.map((c) => [c.deliveryDay, new Date(`${c.deliveryDay}T00:00:00.000Z`)])).values()];
  const result = await republishAndDetect(profile.id, days, args.actor, now);
  return { ...result, confirmed: candidates.length };
}

/** Закрыть проблему без исправления — владелец решил, что она не требует действий. */
export async function dismissIssue(args: { issueId: string; comment: string; actor: FixActor }): Promise<void> {
  assertOwner(args.actor);
  if (!args.comment.trim()) throw new FinanceFixError("comment_required", "Укажите причину.");
  await prisma.financeIssue.update({
    where: { id: args.issueId },
    data: {
      status: "DISMISSED",
      resolvedAt: new Date(),
      resolvedBy: args.actor.userId,
      resolutionComment: args.comment.trim(),
    },
  });
}
