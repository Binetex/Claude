import "server-only";
/**
 * Детектор проблем Finance Setup Assistant.
 *
 * ФАКТ наличия проблемы определяет ЭТОТ пересчёт, а не таблица: `FinanceIssue` —
 * проекция, которая хранит личность проблемы, предложение и разбор. Всё, что перестало
 * находиться, закрывается как AUTO_RESOLVED. Поэтому таблица не может «протухнуть»:
 * она догоняет реальность при каждом прогоне.
 *
 * Детектор ничего не чинит и не считает деньги — он только рассказывает, чего не хватает.
 */
import { Prisma } from "@/generated/prisma/client";
import type { FinanceActionType, FinanceIssueSeverity, FinanceIssueType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { computeDay, dayKey } from "./dayFinance";
import type { DayFinanceResult } from "./dayCalc";
import { resolveItemsFinance } from "./itemFinance";
import { resolveOwnerTaxPolicy } from "./settings";
import { primaryShareGate } from "./config";
import { todayStrInTz } from "@/lib/tz";

/** Сколько дней назад смотрит детектор. Дальше история разбирается вручную по дате. */
export const DETECTOR_WINDOW_DAYS = 60;

type Draft = {
  type: FinanceIssueType;
  severity: FinanceIssueSeverity;
  deduplicationKey: string;
  scopeDate: Date | null;
  siteId: string | null;
  orderId: string | null;
  floristId: string | null;
  sourceEntity: string;
  sourceEntityId: string;
  suggestedActionType: FinanceActionType;
  suggestedValueJson?: Prisma.InputJsonValue;
  detailJson?: Prisma.InputJsonValue;
  estimatedImpactCents?: number | null;
};

export type DetectResult = { opened: number; updated: number; reopened: number; autoResolved: number; scannedDays: number };

/**
 * Прогоняет детектор по окну дней и приводит таблицу проблем в соответствие с реальностью.
 * Идемпотентен: повторный прогон без изменений в данных не создаёт и не закрывает ничего.
 */
export async function detectFinanceIssues(now: Date = new Date()): Promise<DetectResult> {
  // Без даты запуска расчёта проверять нечего: система не должна требовать привести
  // в порядок период, когда финансовые настройки ещё не существовали.
  const gate = primaryShareGate();
  if (!gate.enabled) return closeOutOfScope(now, null);

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, effectiveFrom: true, florist: { select: { user: { select: { name: true } } } } },
  });
  if (!profile) return { opened: 0, updated: 0, reopened: 0, autoResolved: 0, scannedDays: 0 };

  const windowStart = new Date(now.getTime() - DETECTOR_WINDOW_DAYS * 86400_000);
  // Нижняя граница — САМАЯ ПОЗДНЯЯ из трёх: окно детектора, начало профиля и дата
  // запуска расчёта. Заказы раньше неё исторические и в проверки не входят.
  const from = [windowStart, profile.effectiveFrom, gate.startDate].reduce((a, b) => (a > b ? a : b));

  // Дни, в которых у основного флориста есть доставленные заказы.
  const days = await prisma.order.findMany({
    where: {
      currentFloristId: profile.floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: from, lte: now },
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "desc" },
  });

  const drafts: Draft[] = [];
  for (const { deliveryDate } of days) {
    const result = await computeDay(profile.id, deliveryDate);
    if (!result) continue;
    // Подробности нужны только по проблемным заказам, и запрашиваются только для них:
    // на здоровом дне детектор не платит ни одного лишнего запроса.
    const meta = await metaForOrders(result.orders.filter((o) => o.missing.length > 0).map((o) => o.orderId), deliveryDate);
    drafts.push(...draftsForDay(result, meta, profile.id, profile.floristId, deliveryDate));
  }
  drafts.push(...(await globalDrafts(profile.floristId, now)));

  return reconcile(drafts, gate.startDate);
}

/**
 * Гейт закрыт: находить нечего, но уже открытые проблемы висеть не должны — иначе очередь
 * продолжала бы требовать разбора того, что система больше не проверяет.
 */
async function closeOutOfScope(now: Date, startDate: Date | null): Promise<DetectResult> {
  const open = await prisma.financeIssue.findMany({ where: { status: "OPEN" }, select: { id: true } });
  if (open.length === 0) return { opened: 0, updated: 0, reopened: 0, autoResolved: 0, scannedDays: 0 };
  await prisma.financeIssue.updateMany({
    where: { id: { in: open.map((o) => o.id) } },
    data: {
      status: "AUTO_RESOLVED",
      resolvedAt: now,
      resolutionComment: startDate
        ? "Вне периода расчёта: заказ раньше даты запуска."
        : "Расчёт доли не запущен: FINANCE_PRIMARY_SHARE_START_DATE не задана.",
    },
  });
  return { opened: 0, updated: 0, reopened: 0, autoResolved: open.length, scannedDays: 0 };
}

type OrderMeta = {
  orderNumber: string;
  siteId: string;
  siteShortName: string;
  items: Array<{ id: string; name: string; financialType: string | null; catalogReasons: string[] }>;
};

/** Подробности проблемных заказов: название магазина и разбор позиций. */
async function metaForOrders(orderIds: string[], day: Date): Promise<Map<string, OrderMeta>> {
  const out = new Map<string, OrderMeta>();
  if (orderIds.length === 0) return out;

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      siteId: true,
      site: { select: { shortName: true } },
      items: { select: { id: true, name: true, quantity: true, productId: true, variantId: true } },
    },
  });

  const finance = await resolveItemsFinance(orders.flatMap((o) => o.items));

  for (const o of orders) {
    out.set(o.id, {
      orderNumber: o.orderNumber,
      siteId: o.siteId,
      siteShortName: o.site.shortName,
      items: o.items.map((i) => {
        const fin = finance.get(i.id);
        return {
          id: i.id,
          name: i.name,
          financialType: fin?.financialType ?? null,
          catalogReasons: fin?.reasons ?? [],
        };
      }),
    });
  }
  return out;
}

/** Проблемы одного дня: сначала блокеры дня, затем поштучные по заказам. */
function draftsForDay(
  result: DayFinanceResult,
  meta: Map<string, OrderMeta>,
  profileId: string,
  floristId: string,
  day: Date
): Draft[] {
  const out: Draft[] = [];
  const key = dayKey(day);
  const orderCount = result.ordersTotal;

  if (result.blockers.includes("DAILY_FLOWER_EXPENSE_MISSING")) {
    out.push({
      type: "DAILY_FLOWER_EXPENSE_MISSING",
      severity: "BLOCKING",
      deduplicationKey: `DAILY_FLOWER_EXPENSE_MISSING:${profileId}:${key}`,
      scopeDate: day,
      siteId: null,
      orderId: null,
      floristId,
      sourceEntity: "Day",
      sourceEntityId: `${profileId}:${key}`,
      suggestedActionType: "SET_DAILY_FLOWER_EXPENSE",
      detailJson: {
        day: key,
        orderCount,
        reason: "За этот день не внесены расходы на цветы — главный расход дня неизвестен.",
      },
      // Без кандидатского значения эффект посчитать нельзя; ноль соврал бы.
      estimatedImpactCents: null,
    });
  }

  // Поштучные проблемы заказов. Пока хоть одна не разобрана, день не считается целиком:
  // подставить ноль вместо неизвестного расхода значило бы завысить прибыль.
  for (const computed of result.orders) {
    if (computed.missing.length === 0) continue;
    const m = meta.get(computed.orderId);
    if (!m) continue;

    for (const missing of computed.missing) {
      if (missing === "DELIVERY_ACTUAL_COST") {
        out.push({
          type: "DELIVERY_ACTUAL_COST_MISSING",
          severity: "BLOCKING",
          deduplicationKey: `DELIVERY_ACTUAL_COST_MISSING:${computed.orderId}`,
          scopeDate: day,
          siteId: m.siteId,
          orderId: computed.orderId,
          floristId,
          sourceEntity: "Order",
          sourceEntityId: computed.orderId,
          suggestedActionType: "SET_DELIVERY_ACTUAL_COST",
          detailJson: { orderNumber: m.orderNumber, site: m.siteShortName, day: key },
          estimatedImpactCents: null,
        });
      }

      if (missing === "ACQUIRING_FEE") {
        out.push({
          type: "ACQUIRING_FEE_MODEL_MISSING",
          severity: "BLOCKING",
          deduplicationKey: `ACQUIRING_FEE_MODEL_MISSING:${m.siteId}`,
          scopeDate: day,
          siteId: m.siteId,
          orderId: null,
          floristId,
          sourceEntity: "Site",
          sourceEntityId: m.siteId,
          suggestedActionType: "CREATE_SITE_FEE_MODEL",
          // Типовая ставка карточного эквайринга — предложение, а не факт.
          suggestedValueJson: { percentBp: 290, fixedCents: 30 },
          detailJson: {
            site: m.siteShortName,
            reason: "У магазина нет ни фактической комиссии, ни модели расчёта.",
          },
          estimatedImpactCents: null,
        });
      }

      if (missing === "VASE_GIFT_COST") {
        for (const item of m.items) {
          if (item.catalogReasons.length === 0) continue;
          const linkMissing = item.catalogReasons.includes("VASE_LINK_MISSING");
          out.push({
            type: linkMissing ? "VASE_LINK_MISSING" : item.financialType === "GIFT" ? "GIFT_COST_MISSING" : "VASE_COST_MISSING",
            severity: "BLOCKING",
            deduplicationKey: `${linkMissing ? "VASE_LINK_MISSING" : "VASE_COST_MISSING"}:${item.id}`,
            scopeDate: day,
            siteId: m.siteId,
            orderId: computed.orderId,
            floristId,
            sourceEntity: "OrderItem",
            sourceEntityId: item.id,
            suggestedActionType: linkMissing ? "LINK_VASE_VARIANT" : "SET_VASE_PURCHASE_COST",
            detailJson: {
              orderNumber: m.orderNumber,
              itemName: item.name,
              financialType: item.financialType,
              reasons: item.catalogReasons,
              day: key,
            },
            estimatedImpactCents: null,
          });
        }
      }

      if (missing === "CONSUMABLES_RATE") {
        out.push({
          type: "CONSUMABLES_RATE_MISSING",
          severity: "BLOCKING",
          deduplicationKey: `CONSUMABLES_RATE_MISSING:${m.siteId}`,
          scopeDate: day,
          siteId: m.siteId,
          orderId: null,
          floristId,
          sourceEntity: "Site",
          sourceEntityId: m.siteId,
          suggestedActionType: "SET_CONSUMABLES_RATE",
          suggestedValueJson: { amountCents: 500 },
          detailJson: { site: m.siteShortName, reason: "Ставка расходников не задана ни для магазина, ни глобально." },
          estimatedImpactCents: null,
        });
      }
    }

  }

  return out;
}

/**
 * Проблемы, не привязанные к дню: отсутствие налоговой политики владельца.
 * Это WARNING, а не блокер — база флориста берёт 100% налога независимо от политики,
 * поэтому её отсутствие искажает только картину прибыли владельца.
 */
async function globalDrafts(floristId: string, now: Date): Promise<Draft[]> {
  const sites = await prisma.site.findMany({ select: { id: true, shortName: true } });
  const out: Draft[] = [];

  for (const site of sites) {
    const policy = await resolveOwnerTaxPolicy(site.id);
    if (policy) continue;
    const hasOrders = await prisma.order.count({
      where: { siteId: site.id, currentFloristId: floristId, orderStatus: "DELIVERED" },
    });
    if (hasOrders === 0) continue;

    const taxSum = await prisma.order.aggregate({
      where: { siteId: site.id, currentFloristId: floristId, orderStatus: "DELIVERED" },
      _sum: { tax: true },
    });

    out.push({
      type: "OWNER_TAX_POLICY_MISSING",
      severity: "WARNING",
      deduplicationKey: `OWNER_TAX_POLICY_MISSING:${site.id}`,
      scopeDate: null,
      siteId: site.id,
      orderId: null,
      floristId,
      sourceEntity: "Site",
      sourceEntityId: site.id,
      suggestedActionType: "SET_OWNER_TAX_POLICY",
      suggestedValueJson: { actualShareBp: 2000 },
      detailJson: {
        site: site.shortName,
        collectedTaxCents: Math.round(toNumber(taxSum._sum.tax) * 100),
        reason: "Начисление флористу считается и без неё: в его базе налог вычитается на 100%. Политика влияет только на вашу прибыль.",
      },
      estimatedImpactCents: null,
    });
  }

  return out;
}

/**
 * Приводит таблицу к результату детектора: обновляет найденные, открывает новые
 * и закрывает исчезнувшие как AUTO_RESOLVED.
 *
 * Разобранные вручную (RESOLVED/DISMISSED) НЕ переоткрываются автоматически, если
 * проблема всё ещё находится: владелец мог сознательно её закрыть. Вместо этого
 * обновляется lastDetectedAt — в очереди такие видны отдельным фильтром.
 */
async function reconcile(rawDrafts: Draft[], startDate: Date): Promise<DetectResult> {
  const now = new Date();

  // Одна проблема магазина всплывает на КАЖДОМ его проблемном заказе, поэтому в сыром
  // списке ключ повторяется. Схлопываем: карточка должна быть одна, а число затронутых
  // заказов — полезная часть её содержимого, а не повод завести вторую строку.
  const merged = new Map<string, Draft>();
  for (const draft of rawDrafts) {
    const seen = merged.get(draft.deduplicationKey);
    if (!seen) {
      merged.set(draft.deduplicationKey, { ...draft, detailJson: withAffected(draft.detailJson, 1) });
      continue;
    }
    const count = affectedOf(seen.detailJson) + 1;
    merged.set(draft.deduplicationKey, { ...seen, detailJson: withAffected(seen.detailJson, count) });
  }
  const drafts = [...merged.values()];
  const keys = drafts.map((d) => d.deduplicationKey);

  const existing = await prisma.financeIssue.findMany({
    where: { OR: [{ deduplicationKey: { in: keys } }, { status: "OPEN" }] },
    select: { id: true, deduplicationKey: true, status: true, scopeDate: true },
  });
  const byKey = new Map(existing.map((e) => [e.deduplicationKey, e]));

  let opened = 0;
  let updated = 0;
  let reopened = 0;

  for (const draft of drafts) {
    const found = byKey.get(draft.deduplicationKey);
    if (!found) {
      await prisma.financeIssue.create({
        data: {
          type: draft.type,
          severity: draft.severity,
          deduplicationKey: draft.deduplicationKey,
          scopeDate: draft.scopeDate,
          siteId: draft.siteId,
          orderId: draft.orderId,
          floristId: draft.floristId,
          sourceEntity: draft.sourceEntity,
          sourceEntityId: draft.sourceEntityId,
          suggestedActionType: draft.suggestedActionType,
          suggestedValueJson: draft.suggestedValueJson,
          detailJson: draft.detailJson,
          estimatedImpactCents: draft.estimatedImpactCents ?? null,
        },
      });
      opened++;
      continue;
    }

    // Снова найденная проблема возвращается в очередь — кроме той, что владелец закрыл
    // СОЗНАТЕЛЬНО без исправления (DISMISSED): это его решение, и отменять его нельзя.
    //
    // RESOLVED переоткрывается тоже, и это не противоречие: статус означает «владелец
    // исправил», а раз детектор находит проблему снова — исправление не сработало.
    // Так было с ошибочной датой начала настройки: значение внесено, галочка стоит,
    // а расчёт по-прежнему заблокирован. Прятать такое — худшее из возможного:
    // владелец уверен, что дело сделано, и не понимает, почему ничего не считается.
    const reopen = found.status === "AUTO_RESOLVED" || found.status === "RESOLVED";

    await prisma.financeIssue.update({
      where: { id: found.id },
      data: {
        lastDetectedAt: now,
        severity: draft.severity,
        suggestedValueJson: draft.suggestedValueJson,
        detailJson: draft.detailJson,
        estimatedImpactCents: draft.estimatedImpactCents ?? null,
        ...(reopen ? { status: "OPEN", resolvedAt: null, resolvedBy: null, resolutionComment: null } : {}),
      },
    });
    if (reopen) reopened++;
    else updated++;
  }

  // Открытые проблемы, которых детектор больше не находит, закрываются сами.
  const stillOpenKeys = new Set(keys);
  const gone = existing.filter((e) => e.status === "OPEN" && !stillOpenKeys.has(e.deduplicationKey));
  if (gone.length > 0) {
    // Причина закрытия должна быть честной: «данные заполнены» и «период больше не
    // проверяется» — разные вещи, и путать их в истории разбора нельзя.
    const historical = gone.filter((g) => g.scopeDate != null && g.scopeDate < startDate);
    const filled = gone.filter((g) => !historical.includes(g));

    if (historical.length > 0) {
      await prisma.financeIssue.updateMany({
        where: { id: { in: historical.map((g) => g.id) } },
        data: {
          status: "AUTO_RESOLVED",
          resolvedAt: now,
          resolutionComment: "Исторический период: заказ раньше даты запуска расчёта.",
        },
      });
    }
    if (filled.length > 0) {
      await prisma.financeIssue.updateMany({
        where: { id: { in: filled.map((g) => g.id) } },
        data: { status: "AUTO_RESOLVED", resolvedAt: now, resolutionComment: "Проблема исчезла: данные заполнены." },
      });
    }
  }

  return { opened, updated, reopened, autoResolved: gone.length, scannedDays: 0 };
}

/** Сколько заказов затронуто проблемой — хранится внутри detailJson. */
function affectedOf(detail: Prisma.InputJsonValue | undefined): number {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return 0;
  const value = (detail as Record<string, unknown>).affectedOrders;
  return typeof value === "number" ? value : 0;
}

function withAffected(detail: Prisma.InputJsonValue | undefined, count: number): Prisma.InputJsonValue {
  const base = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  return { ...base, affectedOrders: count } as Prisma.InputJsonValue;
}

// ─────────────────────────── Чтение очереди ───────────────────────────

export type IssueGroup = "TODAY" | "LAST_7_DAYS" | "OLDER" | "NO_DATE";

export function groupFor(scopeDate: Date | null, now: Date = new Date()): IssueGroup {
  if (!scopeDate) return "NO_DATE";
  // «Сегодня» — по календарю магазина: по UTC вечерние проблемы каждый день выпадали из
  // группы TODAY в LAST_7_DAYS, потому что UTC уже переваливал за полночь.
  const today = new Date(`${todayStrInTz(null, now)}T00:00:00.000Z`);
  if (scopeDate.getTime() >= today.getTime()) return "TODAY";
  if (scopeDate.getTime() >= today.getTime() - 7 * 86400_000) return "LAST_7_DAYS";
  return "OLDER";
}

export type IssueFilters = { siteId?: string; type?: FinanceIssueType; group?: IssueGroup };

export async function listOpenIssues(filters: IssueFilters = {}) {
  const rows = await prisma.financeIssue.findMany({
    where: {
      status: "OPEN",
      ...(filters.siteId ? { siteId: filters.siteId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    },
    orderBy: [{ severity: "asc" }, { scopeDate: "desc" }, { createdAt: "desc" }],
    include: {
      site: { select: { shortName: true } },
      order: { select: { orderNumber: true } },
      florist: { select: { user: { select: { name: true } } } },
    },
  });
  const now = new Date();
  const withGroup = rows.map((r) => ({ ...r, group: groupFor(r.scopeDate, now) }));
  return filters.group ? withGroup.filter((r) => r.group === filters.group) : withGroup;
}

/** Счётчики для шапки: блокирует, предупреждения, готово к расчёту, затронутая сумма. */
export async function getIssueSummary(now: Date = new Date()) {
  const [blocking, warning, info] = await Promise.all([
    prisma.financeIssue.count({ where: { status: "OPEN", severity: "BLOCKING" } }),
    prisma.financeIssue.count({ where: { status: "OPEN", severity: "WARNING" } }),
    prisma.financeIssue.count({ where: { status: "OPEN", severity: "INFO" } }),
  ]);

  const impact = await prisma.financeIssue.aggregate({
    where: { status: "OPEN", estimatedImpactCents: { not: null } },
    _sum: { estimatedImpactCents: true },
  });

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true },
  });

  // «Готово к расчёту» — дни без блокирующих проблем, начиная с даты запуска расчёта.
  // Исторические дни сюда не входят: система их не проверяет и готовыми не считает.
  const shareGate = primaryShareGate();
  let readyDays = 0;
  if (profile && shareGate.enabled) {
    const window = new Date(now.getTime() - DETECTOR_WINDOW_DAYS * 86400_000);
    const lowerBound = shareGate.startDate > window ? shareGate.startDate : window;
    const days = await prisma.order.findMany({
      where: { currentFloristId: profile.floristId, orderStatus: "DELIVERED", deliveryDate: { gte: lowerBound, lte: now } },
      select: { deliveryDate: true },
      distinct: ["deliveryDate"],
    });
    const blockedDays = await prisma.financeIssue.findMany({
      where: { status: "OPEN", severity: "BLOCKING", scopeDate: { not: null } },
      select: { scopeDate: true },
    });
    const blocked = new Set(blockedDays.map((b) => dayKey(b.scopeDate!)));
    readyDays = days.filter((d) => !blocked.has(dayKey(d.deliveryDate))).length;
  }

  return {
    blocking,
    warning,
    info,
    readyDays,
    estimatedImpactCents: impact._sum.estimatedImpactCents ?? null,
    /** NULL — расчёт не запущен: очередь пуста намеренно, а не потому что всё заполнено. */
    startDate: shareGate.enabled ? shareGate.startDate : null,
    disabledReason: shareGate.enabled ? null : shareGate.reason,
  };
}
