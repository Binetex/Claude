import "server-only";
/**
 * Исправление и удаление эффективно-датированных настроек расчёта:
 * ставка расходников, модель комиссии магазина, налоговая политика владельца.
 *
 * Здесь различаются две операции, которые легко перепутать, а последствия у них разные:
 *
 *   НОВАЯ СТАВКА — ставка действительно изменилась с какого-то дня. Прежний период
 *   закрывается, создаётся новый. Прошлые расчёты остаются верными и не пересобираются.
 *   Это делают setConsumablesRate/setFeeModel/setOwnerTaxPolicy (см. settings.ts).
 *
 *   ИСПРАВЛЕНИЕ — ставку ввели неправильно, и неправильной она была с самого начала.
 *   Новый период не создаётся, правится существующий, а все расчёты внутри него
 *   пересобираются. Именно поэтому исправление может двинуть чужой баланс, а новая
 *   ставка — нет.
 *
 * Удаление — частный случай исправления: запись не должна была существовать вовсе.
 * Освободившийся отрезок забирает предыдущий период, чтобы не осталось дня без настройки.
 *
 * Порядок после любой записи один и тот же и нарушать его нельзя:
 *   правка → аудит → новая ревизия снимков затронутых дней → детектор → пересчёт доли.
 * Решения «трогать ли ledger» здесь нет: если доля не изменилась, accrueDayShare сам
 * вернёт UNCHANGED. Второе мнение о том, изменились ли деньги, заводить нельзя.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { computeDay, dayKey, type DayOverrides } from "./dayFinance";
import { dayShareCents } from "./dayCalc";
import { primaryShareStartDate } from "./config";
import { recalculateAffectedFinance, type FixResult } from "./fix";
import {
  affectedRange,
  leavesNoCoverage,
  planIntervalCorrection,
  planIntervalDeletion,
  IntervalError,
  type IntervalRow,
  type IntervalStep,
} from "./intervals";

export class SettingsAdminError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "SettingsAdminError";
  }
}

export type AdminActor = { userId: string; role: Role };

export type SettingEntity = "CONSUMABLES_RATE" | "FEE_MODEL" | "TAX_POLICY";

/** Значения записи. Форма зависит от настройки, поэтому союз, а не общий мешок полей. */
export type SettingValues =
  | { entity: "CONSUMABLES_RATE"; amountCents: number }
  | { entity: "FEE_MODEL"; percentBp: number; fixedCents: number }
  | { entity: "TAX_POLICY"; actualShareBp: number };

export type SettingRecord = {
  id: string;
  entity: SettingEntity;
  siteId: string | null;
  siteShortName: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  values: SettingValues;
  comment: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: Date;
  /** Действует прямо сейчас. */
  active: boolean;
  /** Есть ли предыдущий период в этой же цепочке — от этого зависит эффект удаления. */
  hasPrevious: boolean;
};

function assertOwner(actor: AdminActor): void {
  if (actor.role !== "OWNER") {
    throw new SettingsAdminError("forbidden", "Настройки расчёта правит только владелец.");
  }
}

function assertNonNegativeInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SettingsAdminError("bad_amount", `${what} должно быть целым неотрицательным числом.`);
  }
}

function assertBp(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new SettingsAdminError("bad_bp", `${what} задаётся в базисных пунктах от 0 до 10000.`);
  }
}

function assertValues(values: SettingValues): void {
  if (values.entity === "CONSUMABLES_RATE") assertNonNegativeInt(values.amountCents, "Ставка расходников");
  else if (values.entity === "FEE_MODEL") {
    assertBp(values.percentBp, "Процент комиссии");
    assertNonNegativeInt(values.fixedCents, "Фиксированная часть комиссии");
  } else assertBp(values.actualShareBp, "Доля налогового расхода");
}

/**
 * Влияет ли настройка на долю флориста.
 *
 * Налоговая политика — не влияет: в базе начисления Order.tax вычитается на 100%
 * независимо от неё (см. computeDay, taxExpenseShareBp по умолчанию 10000). Она нужна
 * только владельческой отчётности. Делать вид, что её правка что-то начислит, нельзя —
 * предпросмотр обязан говорить это прямо.
 */
function affectsShare(entity: SettingEntity): boolean {
  return entity !== "TAX_POLICY";
}

// ─────────────────────────── Чтение ───────────────────────────

/** Все записи всех трёх настроек, с соседями по цепочке и именами авторов. */
export async function listSettingRecords(now: Date = new Date()): Promise<SettingRecord[]> {
  const [rates, feeModels, taxPolicies] = await Promise.all([
    prisma.consumablesRate.findMany({ include: { site: { select: { shortName: true } } } }),
    prisma.siteAcquiringFeeModel.findMany({ include: { site: { select: { shortName: true } } } }),
    prisma.ownerTaxPolicy.findMany({ include: { site: { select: { shortName: true } } } }),
  ]);

  const rows: SettingRecord[] = [
    ...rates.map((r) => ({
      id: r.id,
      entity: "CONSUMABLES_RATE" as const,
      siteId: r.siteId,
      siteShortName: r.site?.shortName ?? null,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      values: { entity: "CONSUMABLES_RATE" as const, amountCents: r.amountCents },
      comment: r.comment,
      createdBy: r.createdBy,
      createdByName: null,
      createdAt: r.createdAt,
      active: false,
      hasPrevious: false,
    })),
    ...feeModels.map((r) => ({
      id: r.id,
      entity: "FEE_MODEL" as const,
      siteId: r.siteId,
      siteShortName: r.site?.shortName ?? null,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      values: { entity: "FEE_MODEL" as const, percentBp: r.percentBp, fixedCents: r.fixedCents },
      comment: r.comment,
      createdBy: r.createdBy,
      createdByName: null,
      createdAt: r.createdAt,
      active: false,
      hasPrevious: false,
    })),
    ...taxPolicies.map((r) => ({
      id: r.id,
      entity: "TAX_POLICY" as const,
      siteId: r.siteId,
      siteShortName: r.site?.shortName ?? null,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      values: { entity: "TAX_POLICY" as const, actualShareBp: r.actualShareBp },
      comment: r.comment,
      createdBy: r.createdBy,
      createdByName: null,
      createdAt: r.createdAt,
      active: false,
      hasPrevious: false,
    })),
  ];

  for (const row of rows) {
    row.active =
      row.effectiveFrom.getTime() <= now.getTime() &&
      (row.effectiveTo == null || row.effectiveTo.getTime() > now.getTime());
    row.hasPrevious = rows.some(
      (o) => sameChain(o, row) && o.id !== row.id && o.effectiveFrom.getTime() < row.effectiveFrom.getTime()
    );
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.createdBy))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  for (const row of rows) row.createdByName = nameById.get(row.createdBy) ?? null;

  return rows.sort(
    (a, b) =>
      a.entity.localeCompare(b.entity) ||
      (a.siteShortName ?? "").localeCompare(b.siteShortName ?? "") ||
      b.effectiveFrom.getTime() - a.effectiveFrom.getTime()
  );
}

/** Одна цепочка = одна настройка одной области действия. */
function sameChain(a: { entity: SettingEntity; siteId: string | null }, b: { entity: SettingEntity; siteId: string | null }) {
  return a.entity === b.entity && a.siteId === b.siteId;
}

async function loadChain(entity: SettingEntity, siteId: string | null): Promise<IntervalRow[]> {
  const select = { id: true, effectiveFrom: true, effectiveTo: true };
  if (entity === "CONSUMABLES_RATE") return prisma.consumablesRate.findMany({ where: { siteId }, select });
  if (entity === "FEE_MODEL") return prisma.siteAcquiringFeeModel.findMany({ where: { siteId: siteId ?? "" }, select });
  return prisma.ownerTaxPolicy.findMany({ where: { siteId }, select });
}

async function loadRecord(entity: SettingEntity, id: string): Promise<SettingRecord> {
  const all = await listSettingRecords();
  const row = all.find((r) => r.entity === entity && r.id === id);
  if (!row) throw new SettingsAdminError("not_found", "Запись настройки не найдена.");
  return row;
}

// ─────────────────────────── Предпросмотр ───────────────────────────

export type SettingPreviewDay = {
  day: string;
  ordersTotal: number;
  /** Заказы, у которых пересчёт меняет денежные поля снимка. */
  ordersChanged: number;
  orderNumbers: string[];
  shareBeforeCents: number | null;
  shareAfterCents: number | null;
  accruedCents: number | null;
};

export type SettingPreview = {
  entity: SettingEntity;
  op: "CORRECT" | "DELETE";
  affectedDays: number;
  affectedOrders: number;
  shareBeforeCents: number;
  shareAfterCents: number;
  shareDeltaCents: number;
  /** Дни, где заработок флориста изменится. */
  daysChanged: number;
  days: SettingPreviewDay[];
  warnings: string[];
};

/**
 * Что произойдёт, если применить правку. Ничего не пишет.
 *
 * Считается тем же движком, что и настоящий расчёт: тот же вход дня с подменёнными
 * значениями настройки. Подменяются они ПОДНЕВНО, а не одним числом на весь период —
 * при сдвиге границы дни по разные стороны от неё получают разные ставки, и «одно
 * значение на всё» показало бы не то, что произойдёт.
 */
export async function previewSettingChange(args: {
  entity: SettingEntity;
  id: string;
  op: "CORRECT" | "DELETE";
  /** Для CORRECT: новые значения и новая дата начала. */
  values?: SettingValues;
  effectiveFrom?: Date;
  now?: Date;
}): Promise<SettingPreview> {
  const now = args.now ?? new Date();
  const record = await loadRecord(args.entity, args.id);
  if (args.values) assertValues(args.values);

  const chain = await loadChain(args.entity, record.siteId);
  const nextFrom = args.op === "CORRECT" ? (args.effectiveFrom ?? record.effectiveFrom) : undefined;

  // План интервалов проверяется и здесь: несуществующая правка не должна доходить до
  // экрана предпросмотра как «ничего не изменится».
  if (args.op === "CORRECT") planIntervalCorrection(chain, args.id, nextFrom!);

  const warnings: string[] = [];
  const profile = await activeProfile();
  if (!profile) {
    return emptyPreview(args.entity, args.op, ["Нет действующего профиля основного флориста — пересчитывать нечего."]);
  }

  const range = affectedRange(chain, args.id, nextFrom ? { nextFrom } : {});
  const days = await affectedDays(profile.floristId, record.siteId, range, now);

  if (args.op === "DELETE") {
    if (leavesNoCoverage(chain, args.id)) {
      warnings.push("Это последняя запись настройки. После удаления она исчезнет полностью, и дни попадут в «Требует заполнения» как блокирующая проблема.");
    } else if (!record.hasPrevious) {
      warnings.push("Это самая ранняя запись. Её отрезок покрыть нечем, поэтому до начала следующего периода настройки не будет.");
    } else {
      warnings.push("Освободившийся отрезок заберёт предыдущий период — дня без настройки не останется.");
    }
  }

  if (!affectsShare(args.entity)) {
    warnings.push("Налоговая политика на долю флориста не влияет: в её базе налог вычитается полностью. Правка меняет только владельческую отчётность.");
    return { ...emptyPreview(args.entity, args.op, warnings), affectedDays: days.length };
  }

  // Значения после правки — в памяти, без записи в БД.
  const simulated = simulateChain(chain, record, args, nextFrom);

  const perDay: SettingPreviewDay[] = [];
  let shareBefore = 0;
  let shareAfter = 0;
  let orders = 0;
  let daysChanged = 0;
  const bp = profile.sharePercentBp ?? 0;

  for (const day of days) {
    const before = await computeDay(profile.id, day);
    if (!before) continue;

    const overrides = await overridesForDay(args.entity, record, simulated, day);
    const after = await computeDay(profile.id, day, overrides);
    if (!after) continue;

    const shareB = before.complete ? dayShareCents(before.distributableCents, bp) : null;
    const shareA = after.complete ? dayShareCents(after.distributableCents, bp) : null;

    // Заказы, у которых изменился вклад в прибыль дня, — именно их и стоит назвать
    // владельцу: «затронуто N заказов» без разбора включало бы и те, где ничего не сдвинулось.
    const beforeByOrder = new Map(before.orders.map((o) => [o.orderId, o.contributionCents]));
    const changed = after.orders.filter((o) => beforeByOrder.get(o.orderId) !== o.contributionCents);

    shareBefore += shareB ?? 0;
    shareAfter += shareA ?? 0;
    orders += after.ordersTotal;
    if (shareA !== shareB) daysChanged++;

    perDay.push({
      day: dayKey(day),
      ordersTotal: after.ordersTotal,
      ordersChanged: changed.length,
      orderNumbers: changed.map((c) => c.orderNumber),
      shareBeforeCents: shareB,
      shareAfterCents: shareA,
      accruedCents: shareB,
    });
  }

  if (daysChanged > 0) {
    warnings.push(`Заработок флориста изменится: затронуто дней — ${daysChanged}.`);
  } else if (orders > 0) {
    warnings.push("Денежный результат не меняется.");
  }

  return {
    entity: args.entity,
    op: args.op,
    affectedDays: days.length,
    affectedOrders: orders,
    shareBeforeCents: shareBefore,
    shareAfterCents: shareAfter,
    shareDeltaCents: shareAfter - shareBefore,
    daysChanged,
    days: perDay,
    warnings,
  };
}

function emptyPreview(entity: SettingEntity, op: "CORRECT" | "DELETE", warnings: string[]): SettingPreview {
  return {
    entity,
    op,
    affectedDays: 0,
    affectedOrders: 0,
    shareBeforeCents: 0,
    shareAfterCents: 0,
    shareDeltaCents: 0,
    daysChanged: 0,
    days: [],
    warnings,
  };
}

/** `values` заполнены только у изменяемой записи; у соседей они читаются из БД по мере надобности. */
type SimulatedRow = { id: string; effectiveFrom: Date; effectiveTo: Date | null; values: SettingValues | null };

/** Цепочка после применения правки — только в памяти, для предпросмотра. */
function simulateChain(
  chain: IntervalRow[],
  record: SettingRecord,
  args: { op: "CORRECT" | "DELETE"; values?: SettingValues },
  nextFrom: Date | undefined
): SimulatedRow[] {
  const steps = args.op === "DELETE" ? planIntervalDeletion(chain, record.id) : planIntervalCorrection(chain, record.id, nextFrom!);
  const rows: SimulatedRow[] = chain.map((r) => ({
    ...r,
    // У соседей значения не подставляются: взять сюда величину изменяемой записи —
    // ровно та ошибка, из-за которой предпросмотр показал бы чужую ставку как свою.
    values: r.id === record.id ? (args.values ?? record.values) : null,
  }));
  return applySteps(rows, steps);
}

function applySteps(rows: SimulatedRow[], steps: IntervalStep[]): SimulatedRow[] {
  let out = rows;
  for (const step of steps) {
    if (step.kind === "DELETE") out = out.filter((r) => r.id !== step.id);
    else if (step.kind === "SET_TO") out = out.map((r) => (r.id === step.id ? { ...r, effectiveTo: step.effectiveTo } : r));
    else out = out.map((r) => (r.id === step.id ? { ...r, effectiveFrom: step.effectiveFrom } : r));
  }
  return out;
}

/**
 * Настройка на конкретный день ПОСЛЕ правки, в виде overrides для расчёта.
 *
 * Различаются два исхода: значение стало другим и значения на этот день не стало вовсе.
 * Второй возникает при удалении и при сдвиге границы — тогда заказы выпадают из расчёта,
 * и показать это числом невозможно.
 */
async function overridesForDay(
  entity: SettingEntity,
  record: SettingRecord,
  simulated: SimulatedRow[],
  day: Date
): Promise<DayOverrides> {
  const covering = simulated.find(
    (r) => r.effectiveFrom.getTime() <= day.getTime() && (r.effectiveTo == null || r.effectiveTo.getTime() > day.getTime())
  );

  if (entity === "FEE_MODEL") {
    // Комиссия только посайтовая, глобальной не бывает — область правки всегда один магазин.
    const siteId = record.siteId!;
    if (!covering) return { feeModelMissingSites: [siteId] };
    const v = await valuesOf(entity, covering);
    if (v.entity !== "FEE_MODEL") return {};
    return { feeModelBySite: { [siteId]: { percentBp: v.percentBp, fixedCents: v.fixedCents } } };
  }

  if (entity === "CONSUMABLES_RATE") {
    const sites = record.siteId
      ? [record.siteId]
      : (await prisma.site.findMany({ select: { id: true } })).map((s) => s.id);

    const value = covering ? await valuesOf(entity, covering) : null;
    const bySite: Record<string, number> = {};
    const missing: string[] = [];

    for (const siteId of sites) {
      // Ставка магазина приоритетнее глобальной: правка глобальной не касается магазина,
      // у которого на этот день есть своя.
      if (record.siteId == null) {
        const own = await prisma.consumablesRate.findFirst({
          where: { siteId, effectiveFrom: { lte: day }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }] },
          select: { id: true },
        });
        if (own) continue;
      }
      if (value && value.entity === "CONSUMABLES_RATE") bySite[siteId] = value.amountCents;
      else missing.push(siteId);
    }

    return {
      ...(Object.keys(bySite).length ? { consumablesCentsBySite: bySite } : {}),
      ...(missing.length ? { consumablesMissingSites: missing } : {}),
    };
  }

  return {};
}

/** Значения строки: у изменяемой они уже в памяти, у соседей читаются из БД. */
async function valuesOf(entity: SettingEntity, row: SimulatedRow): Promise<SettingValues> {
  if (row.values) return row.values;
  if (entity === "CONSUMABLES_RATE") {
    const r = await prisma.consumablesRate.findUnique({ where: { id: row.id }, select: { amountCents: true } });
    return { entity, amountCents: r?.amountCents ?? 0 };
  }
  if (entity === "FEE_MODEL") {
    const r = await prisma.siteAcquiringFeeModel.findUnique({ where: { id: row.id }, select: { percentBp: true, fixedCents: true } });
    return { entity, percentBp: r?.percentBp ?? 0, fixedCents: r?.fixedCents ?? 0 };
  }
  const r = await prisma.ownerTaxPolicy.findUnique({ where: { id: row.id }, select: { actualShareBp: true } });
  return { entity, actualShareBp: r?.actualShareBp ?? 0 };
}

async function activeProfile() {
  return prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, sharePercentBp: true },
  });
}

/**
 * Дни доставки основного флориста внутри затронутого отрезка.
 *
 * Нижняя граница поджимается датой запуска расчёта: заказы раньше неё исторические, их
 * не пересчитывают и не начисляют — правка старой ставки не должна будить историю.
 */
async function affectedDays(
  floristId: string,
  siteId: string | null,
  range: { from: Date; to: Date | null },
  now: Date
): Promise<Date[]> {
  const start = primaryShareStartDate();
  const from = start && start > range.from ? start : range.from;
  const to = range.to && range.to < now ? range.to : now;
  if (from > to) return [];

  const rows = await prisma.order.findMany({
    where: {
      currentFloristId: floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: from, lte: to },
      ...(siteId ? { siteId } : {}),
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "asc" },
  });
  return rows.map((r) => r.deliveryDate);
}

// ─────────────────────────── Запись ───────────────────────────

export type SettingApplyResult = FixResult & { affectedDays: number };

/**
 * Исправляет ошибочно введённую запись: значения и/или дату начала.
 * Новый период не создаётся — правится существующий.
 */
export async function correctSetting(args: {
  entity: SettingEntity;
  id: string;
  values: SettingValues;
  effectiveFrom: Date;
  reason: string;
  actor: AdminActor;
  now?: Date;
}): Promise<SettingApplyResult> {
  assertOwner(args.actor);
  assertValues(args.values);
  const reason = args.reason.trim();
  if (!reason) throw new SettingsAdminError("reason_required", "Укажите причину исправления.");
  if (args.values.entity !== args.entity) {
    throw new SettingsAdminError("bad_values", "Значения не от той настройки.");
  }

  const now = args.now ?? new Date();
  const record = await loadRecord(args.entity, args.id);
  const chain = await loadChain(args.entity, record.siteId);

  let steps: IntervalStep[];
  try {
    steps = planIntervalCorrection(chain, args.id, args.effectiveFrom);
  } catch (e) {
    if (e instanceof IntervalError) throw new SettingsAdminError(e.reason, e.message);
    throw e;
  }

  const range = affectedRange(chain, args.id, { nextFrom: args.effectiveFrom });

  await prisma.$transaction(async (tx) => {
    await runSteps(tx, args.entity, steps);
    await writeValues(tx, args.entity, args.id, args.values);
    await tx.financeAudit.create({
      data: {
        entity: entityName(args.entity),
        entityId: args.id,
        action: `CORRECT_${entityName(args.entity)}`,
        beforeJson: {
          ...valuesJson(record.values),
          effectiveFrom: record.effectiveFrom.toISOString(),
          effectiveTo: record.effectiveTo?.toISOString() ?? null,
        },
        afterJson: { ...valuesJson(args.values), effectiveFrom: args.effectiveFrom.toISOString() },
        reason,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });

  return runAftermath(record.siteId, range, args.actor, now, args.effectiveFrom);
}

/** Удаляет ошибочную запись, возвращая её отрезок предыдущему периоду. */
export async function deleteSetting(args: {
  entity: SettingEntity;
  id: string;
  reason: string;
  actor: AdminActor;
  now?: Date;
}): Promise<SettingApplyResult> {
  assertOwner(args.actor);
  const reason = args.reason.trim();
  if (!reason) throw new SettingsAdminError("reason_required", "Укажите причину удаления.");

  const now = args.now ?? new Date();
  const record = await loadRecord(args.entity, args.id);
  const chain = await loadChain(args.entity, record.siteId);
  const steps = planIntervalDeletion(chain, args.id);
  const range = affectedRange(chain, args.id, {});

  await prisma.$transaction(async (tx) => {
    // Аудит пишется ДО удаления: FinanceAudit ссылается на entityId строкой, без внешнего
    // ключа, поэтому запись переживает саму настройку и продолжает её объяснять.
    await tx.financeAudit.create({
      data: {
        entity: entityName(args.entity),
        entityId: args.id,
        action: `DELETE_${entityName(args.entity)}`,
        beforeJson: {
          ...valuesJson(record.values),
          effectiveFrom: record.effectiveFrom.toISOString(),
          effectiveTo: record.effectiveTo?.toISOString() ?? null,
          siteId: record.siteId,
        },
        afterJson: { deleted: true },
        reason,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
    await runSteps(tx, args.entity, steps);
  });

  return runAftermath(record.siteId, range, args.actor, now, null);
}

/** Хвост любой правки: пересчёт итогов затронутых дней → детектор. */
async function runAftermath(
  siteId: string | null,
  range: { from: Date; to: Date | null },
  actor: AdminActor,
  now: Date,
  nextFrom: Date | null
): Promise<SettingApplyResult> {
  const profile = await activeProfile();
  if (!profile) {
    return {
      days: 0,
      complete: 0,
      detector: { opened: 0, updated: 0, reopened: 0, autoResolved: 0 },
      affectedDays: 0,
    };
  }

  const widened = nextFrom && nextFrom < range.from ? { ...range, from: nextFrom } : range;
  const days = await affectedDays(profile.floristId, siteId, widened, now);
  const result = await recalculateAffectedFinance(profile.id, days, actor, now);
  return { ...result, affectedDays: days.length };
}

async function runSteps(tx: Prisma.TransactionClient, entity: SettingEntity, steps: IntervalStep[]): Promise<void> {
  for (const step of steps) {
    if (entity === "CONSUMABLES_RATE") {
      if (step.kind === "DELETE") await tx.consumablesRate.delete({ where: { id: step.id } });
      else if (step.kind === "SET_TO") await tx.consumablesRate.update({ where: { id: step.id }, data: { effectiveTo: step.effectiveTo } });
      else await tx.consumablesRate.update({ where: { id: step.id }, data: { effectiveFrom: step.effectiveFrom } });
    } else if (entity === "FEE_MODEL") {
      if (step.kind === "DELETE") await tx.siteAcquiringFeeModel.delete({ where: { id: step.id } });
      else if (step.kind === "SET_TO") await tx.siteAcquiringFeeModel.update({ where: { id: step.id }, data: { effectiveTo: step.effectiveTo } });
      else await tx.siteAcquiringFeeModel.update({ where: { id: step.id }, data: { effectiveFrom: step.effectiveFrom } });
    } else {
      if (step.kind === "DELETE") await tx.ownerTaxPolicy.delete({ where: { id: step.id } });
      else if (step.kind === "SET_TO") await tx.ownerTaxPolicy.update({ where: { id: step.id }, data: { effectiveTo: step.effectiveTo } });
      else await tx.ownerTaxPolicy.update({ where: { id: step.id }, data: { effectiveFrom: step.effectiveFrom } });
    }
  }
}

async function writeValues(tx: Prisma.TransactionClient, entity: SettingEntity, id: string, values: SettingValues): Promise<void> {
  if (entity === "CONSUMABLES_RATE" && values.entity === "CONSUMABLES_RATE") {
    await tx.consumablesRate.update({ where: { id }, data: { amountCents: values.amountCents } });
  } else if (entity === "FEE_MODEL" && values.entity === "FEE_MODEL") {
    await tx.siteAcquiringFeeModel.update({ where: { id }, data: { percentBp: values.percentBp, fixedCents: values.fixedCents } });
  } else if (entity === "TAX_POLICY" && values.entity === "TAX_POLICY") {
    await tx.ownerTaxPolicy.update({ where: { id }, data: { actualShareBp: values.actualShareBp } });
  }
}

/** Имя сущности в аудите совпадает с именем модели — по нему история и ищется. */
export function entityName(entity: SettingEntity): string {
  if (entity === "CONSUMABLES_RATE") return "ConsumablesRate";
  if (entity === "FEE_MODEL") return "SiteAcquiringFeeModel";
  return "OwnerTaxPolicy";
}

function valuesJson(values: SettingValues): Prisma.InputJsonObject {
  if (values.entity === "CONSUMABLES_RATE") return { amountCents: values.amountCents };
  if (values.entity === "FEE_MODEL") return { percentBp: values.percentBp, fixedCents: values.fixedCents };
  return { actualShareBp: values.actualShareBp };
}

/** История правок одной записи. */
export async function settingHistory(entity: SettingEntity, id: string) {
  const rows = await prisma.financeAudit.findMany({
    where: { entity: entityName(entity), entityId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      beforeJson: true,
      afterJson: true,
      reason: true,
      role: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    beforeJson: r.beforeJson,
    afterJson: r.afterJson,
    reason: r.reason,
    userName: r.user?.name ?? null,
    role: r.role,
    createdAt: r.createdAt,
  }));
}
