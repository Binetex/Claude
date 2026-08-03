import "server-only";
/**
 * Правка и удаление настроек расчёта: ставка расходников, модель комиссии магазина,
 * налоговая политика владельца.
 *
 * Настройка — одна строка на область с текущим значением. Периодов действия нет, и
 * поэтому нет различения «новая ставка с даты» и «исправление ошибки»: любая правка
 * меняет текущее значение и пересчитывает затронутые дни. История значений живёт в
 * `FinanceAudit` — с автором, временем и причиной.
 *
 * Размен сознательный. Датированные ставки позволяли считать прошлое по старым цифрам,
 * но за это платили интервальной арифметикой, запретом пересечений, симуляцией цепочки
 * периодов и подневной подстановкой значений в предпросмотре — ради вопроса, который в
 * реальной работе не возникал.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { computeDay, dayKey, type DayOverrides } from "./dayFinance";
import { dayShareCents } from "./dayCalc";
import { recalculateAffectedFinance, type FixResult } from "./fix";
import { setConsumablesRate, setFeeModel, setOwnerTaxPolicy } from "./settings";
import { primaryShareStartDate } from "./config";

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
  values: SettingValues;
  comment: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: Date;
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
 * Налоговая политика — не влияет: в базе флориста Order.tax вычитается на 100% независимо
 * от неё. Она нужна только владельческой отчётности. Делать вид, что её правка что-то
 * начислит, нельзя — предпросмотр обязан говорить это прямо.
 */
function affectsShare(entity: SettingEntity): boolean {
  return entity !== "TAX_POLICY";
}

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

// ─────────────────────────── Чтение ───────────────────────────

/** Все записи всех трёх настроек с именами авторов. */
export async function listSettingRecords(): Promise<SettingRecord[]> {
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
      values: { entity: "CONSUMABLES_RATE" as const, amountCents: r.amountCents },
      comment: r.comment,
      createdBy: r.createdBy,
      createdByName: null as string | null,
      createdAt: r.createdAt,
    })),
    ...feeModels.map((m) => ({
      id: m.id,
      entity: "FEE_MODEL" as const,
      siteId: m.siteId,
      siteShortName: m.site.shortName,
      values: { entity: "FEE_MODEL" as const, percentBp: m.percentBp, fixedCents: m.fixedCents },
      comment: m.comment,
      createdBy: m.createdBy,
      createdByName: null as string | null,
      createdAt: m.createdAt,
    })),
    ...taxPolicies.map((p) => ({
      id: p.id,
      entity: "TAX_POLICY" as const,
      siteId: p.siteId,
      siteShortName: p.site?.shortName ?? null,
      values: { entity: "TAX_POLICY" as const, actualShareBp: p.actualShareBp },
      comment: p.comment,
      createdBy: p.createdBy,
      createdByName: null as string | null,
      createdAt: p.createdAt,
    })),
  ];

  const ids = [...new Set(rows.map((r) => r.createdBy))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  for (const r of rows) r.createdByName = nameById.get(r.createdBy) ?? null;

  return rows;
}

/** Одна запись по id. Бросает, если её нет: править нечего. */
async function loadRecord(entity: SettingEntity, id: string): Promise<SettingRecord> {
  const found = (await listSettingRecords()).find((r) => r.entity === entity && r.id === id);
  if (!found) throw new SettingsAdminError("not_found", "Запись настройки не найдена.");
  return found;
}

// ─────────────────────────── Предпросмотр ───────────────────────────

export type SettingPreviewDay = {
  day: string;
  ordersTotal: number;
  ordersChanged: number;
  orderNumbers: string[];
  shareBeforeCents: number | null;
  shareAfterCents: number | null;
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

/**
 * Подмена настройки для расчёта «а что будет».
 *
 * «Значение другое» и «значения нет вовсе» — разные исходы: без ставки заказ выпадает из
 * расчёта целиком, и числом это не выражается.
 */
async function overridesFor(
  entity: SettingEntity,
  record: SettingRecord,
  values: SettingValues | null
): Promise<DayOverrides> {
  if (entity === "FEE_MODEL") {
    // Комиссия только посайтовая, глобальной не бывает.
    const siteId = record.siteId!;
    if (!values || values.entity !== "FEE_MODEL") return { feeModelMissingSites: [siteId] };
    return { feeModelBySite: { [siteId]: { percentBp: values.percentBp, fixedCents: values.fixedCents } } };
  }

  if (entity === "CONSUMABLES_RATE") {
    let targets: string[];
    if (record.siteId) {
      targets = [record.siteId];
    } else {
      // Правка глобальной ставки не касается магазинов со своей: она их не применяется.
      const own = await prisma.consumablesRate.findMany({ where: { siteId: { not: null } }, select: { siteId: true } });
      const covered = new Set(own.map((r) => r.siteId!));
      targets = (await prisma.site.findMany({ select: { id: true } })).map((s) => s.id).filter((id) => !covered.has(id));
    }

    if (!values || values.entity !== "CONSUMABLES_RATE") return { consumablesMissingSites: targets };
    const bySite: Record<string, number> = {};
    for (const siteId of targets) bySite[siteId] = values.amountCents;
    return { consumablesCentsBySite: bySite };
  }

  return {};
}

/**
 * Что произойдёт, если применить правку. Ничего не пишет.
 *
 * Считается тем же движком, что и настоящий расчёт: тот же вход дня с подменённым
 * значением настройки. Предпросмотр со своей формулой рано или поздно разойдётся с тем,
 * что произойдёт на самом деле.
 */
export async function previewSettingChange(args: {
  entity: SettingEntity;
  id: string;
  op: "CORRECT" | "DELETE";
  /** Для CORRECT: новые значения. */
  values?: SettingValues;
  now?: Date;
}): Promise<SettingPreview> {
  const now = args.now ?? new Date();
  const record = await loadRecord(args.entity, args.id);
  if (args.values) assertValues(args.values);

  const warnings: string[] = [];
  const profile = await activeProfile();
  if (!profile) {
    return emptyPreview(args.entity, args.op, ["Нет действующего профиля основного флориста — пересчитывать нечего."]);
  }

  const days = await affectedDays(profile.floristId, record.siteId, now);

  if (args.op === "DELETE") {
    warnings.push(
      "После удаления настройки не станет, и дни, где она нужна, попадут в «Требует заполнения» как блокирующая проблема."
    );
  }

  if (!affectsShare(args.entity)) {
    warnings.push(
      "Налоговая политика на долю флориста не влияет: в её базе налог вычитается полностью. Правка меняет только владельческую отчётность."
    );
    return { ...emptyPreview(args.entity, args.op, warnings), affectedDays: days.length };
  }

  const overrides = await overridesFor(args.entity, record, args.op === "DELETE" ? null : (args.values ?? record.values));

  const perDay: SettingPreviewDay[] = [];
  let shareBefore = 0;
  let shareAfter = 0;
  let orders = 0;
  let daysChanged = 0;
  const bp = profile.sharePercentBp ?? 0;

  for (const day of days) {
    const before = await computeDay(profile.id, day);
    if (!before) continue;
    const after = await computeDay(profile.id, day, overrides);
    if (!after) continue;

    const shareB = before.complete ? dayShareCents(before.distributableCents, bp) : null;
    const shareA = after.complete ? dayShareCents(after.distributableCents, bp) : null;

    // Заказы, у которых изменился вклад в прибыль дня, — именно их и стоит назвать:
    // «затронуто N заказов» без разбора включало бы и те, где ничего не сдвинулось.
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
    });
  }

  if (daysChanged > 0) warnings.push(`Заработок флориста изменится: затронуто дней — ${daysChanged}.`);
  else if (orders > 0) warnings.push("Денежный результат не меняется.");

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

// ─────────────────────────── Запись ───────────────────────────

export type SettingApplyResult = FixResult & { affectedDays: number };

/** Меняет значение настройки и пересчитывает затронутые дни. */
export async function correctSetting(args: {
  entity: SettingEntity;
  id: string;
  values: SettingValues;
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

  // Запись идёт через те же setX, что и создание: второй путь записи означал бы второе
  // мнение о том, как настройка попадает в базу.
  if (args.values.entity === "CONSUMABLES_RATE") {
    await setConsumablesRate({
      siteId: record.siteId,
      amountCents: args.values.amountCents,
      comment: reason,
      actor: args.actor,
    });
  } else if (args.values.entity === "FEE_MODEL") {
    await setFeeModel({
      siteId: record.siteId!,
      percentBp: args.values.percentBp,
      fixedCents: args.values.fixedCents,
      comment: reason,
      actor: args.actor,
    });
  } else {
    await setOwnerTaxPolicy({
      siteId: record.siteId,
      actualShareBp: args.values.actualShareBp,
      comment: reason,
      actor: args.actor,
    });
  }

  await prisma.financeAudit.create({
    data: {
      entity: entityName(args.entity),
      entityId: args.id,
      action: `CORRECT_${entityName(args.entity)}`,
      beforeJson: valuesJson(record.values),
      afterJson: valuesJson(args.values),
      reason,
      userId: args.actor.userId,
      role: args.actor.role,
    },
  });

  return runAftermath(record.siteId, args.actor, now);
}

/** Удаляет настройку. После этого её значение считается неизвестным. */
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

  await prisma.$transaction(async (tx) => {
    // Аудит пишется ДО удаления: FinanceAudit ссылается на entityId строкой, без внешнего
    // ключа, поэтому запись переживает саму настройку и продолжает её объяснять.
    await tx.financeAudit.create({
      data: {
        entity: entityName(args.entity),
        entityId: args.id,
        action: `DELETE_${entityName(args.entity)}`,
        beforeJson: { ...valuesJson(record.values), siteId: record.siteId },
        afterJson: { deleted: true },
        reason,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    if (args.entity === "CONSUMABLES_RATE") await tx.consumablesRate.delete({ where: { id: args.id } });
    else if (args.entity === "FEE_MODEL") await tx.siteAcquiringFeeModel.delete({ where: { id: args.id } });
    else await tx.ownerTaxPolicy.delete({ where: { id: args.id } });
  });

  return runAftermath(record.siteId, args.actor, now);
}

/** Хвост любой правки: пересчёт итогов затронутых дней → детектор. */
async function runAftermath(siteId: string | null, actor: AdminActor, now: Date): Promise<SettingApplyResult> {
  const profile = await activeProfile();
  if (!profile) {
    return { days: 0, complete: 0, detector: { opened: 0, updated: 0, reopened: 0, autoResolved: 0 }, affectedDays: 0 };
  }

  const days = await affectedDays(profile.floristId, siteId, now);
  const result = await recalculateAffectedFinance(profile.id, days, actor, now);
  return { ...result, affectedDays: days.length };
}

async function activeProfile() {
  return prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, sharePercentBp: true },
  });
}

/**
 * Дни доставки основного флориста, которые затронет правка.
 *
 * Периодов у настройки нет, поэтому затронуты ВСЕ дни расчёта: значение одно и действует
 * всегда. Нижняя граница — дата запуска расчёта: заказы раньше неё исторические, их не
 * пересчитывают.
 */
async function affectedDays(floristId: string, siteId: string | null, now: Date): Promise<Date[]> {
  const start = primaryShareStartDate();
  if (!start) return [];

  const rows = await prisma.order.findMany({
    where: {
      currentFloristId: floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: start, lte: now },
      ...(siteId ? { siteId } : {}),
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "asc" },
  });
  return rows.map((r) => r.deliveryDate);
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
