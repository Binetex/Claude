import "server-only";
/**
 * Настройки, из которых складывается расчёт: ставка расходников, модель комиссии
 * магазина, налоговая политика владельца и дневная закупка цветов.
 *
 * Все, кроме закупки, — с датами действия и резолвятся НА ДАТУ ДОСТАВКИ заказа. Правка
 * ставки сегодня не должна менять вчерашний расчёт: снимок уже опубликован по прежней
 * ставке, и её id лежит внутри него.
 *
 * Отсутствие настройки везде означает «неизвестно», а не ноль: подставить ноль в расход —
 * значит завысить прибыль и переплатить долю.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";


export class FinanceSettingsError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "FinanceSettingsError";
  }
}

export type SettingsActor = { userId: string; role: Role };

function assertOwner(actor: SettingsActor): void {
  if (actor.role !== "OWNER") {
    throw new FinanceSettingsError("forbidden", "Финансовые настройки задаёт только владелец.");
  }
}

function assertNonNegativeInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new FinanceSettingsError("bad_amount", `${what} должно быть целым неотрицательным числом.`);
  }
}

function assertBp(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new FinanceSettingsError("bad_bp", `${what} задаётся в базисных пунктах от 0 до 10000.`);
  }
}

// ─────────────────────────── Расходники ───────────────────────────

export type ResolvedConsumables = { amountCents: number; rateId: string; scope: "SITE" | "GLOBAL" };

/**
 * Ставка расходников на дату: настройка магазина приоритетнее глобальной.
 * NULL — ставка не задана, и заказ в расчёт не попадёт.
 */
export async function resolveConsumablesRate(siteId: string): Promise<ResolvedConsumables | null> {
  const rows = await prisma.consumablesRate.findMany({
    where: { OR: [{ siteId }, { siteId: null }] },
    select: { id: true, siteId: true, amountCents: true },
  });
  const site = rows.find((r) => r.siteId === siteId);
  if (site) return { amountCents: site.amountCents, rateId: site.id, scope: "SITE" };
  const global = rows.find((r) => r.siteId === null);
  return global ? { amountCents: global.amountCents, rateId: global.id, scope: "GLOBAL" } : null;
}

/**
 * Задаёт ставку расходников. Строка одна на область: правка переписывает значение.
 *
 * Периодов действия нет. Прежнее значение не теряется — оно в `FinanceAudit`, — но
 * расчёт всегда идёт по текущему. Это сознательный размен: датированные ставки означали
 * бы, что вчерашний день считается не так, как сегодняшний, и «почему тут другая сумма»
 * требовало бы раскопок в интервалах.
 */
export async function setConsumablesRate(args: {
  siteId: string | null;
  amountCents: number;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ id: string; previousCents: number | null }> {
  assertOwner(args.actor);
  assertNonNegativeInt(args.amountCents, "Ставка расходников");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.consumablesRate.findFirst({ where: { siteId: args.siteId } });

    const row = existing
      ? await tx.consumablesRate.update({
          where: { id: existing.id },
          data: { amountCents: args.amountCents, comment: args.comment ?? null },
          select: { id: true },
        })
      : await tx.consumablesRate.create({
          data: {
            siteId: args.siteId,
            amountCents: args.amountCents,
            comment: args.comment ?? null,
            createdBy: args.actor.userId,
          },
          select: { id: true },
        });

    await writeAudit(
      tx,
      "ConsumablesRate",
      row.id,
      existing ? { amountCents: existing.amountCents } : null,
      { amountCents: args.amountCents, siteId: args.siteId },
      args.actor,
      args.comment ?? null
    );

    return { id: row.id, previousCents: existing?.amountCents ?? null };
  });
}

// ─────────────────────── Комиссия эквайринга ───────────────────────

export type ResolvedFeeModel = { modelId: string; percentBp: number; fixedCents: number };

export async function resolveFeeModel(siteId: string): Promise<ResolvedFeeModel | null> {
  const row = await prisma.siteAcquiringFeeModel.findFirst({
    where: { siteId },
    select: { id: true, percentBp: true, fixedCents: true },
  });
  return row ? { modelId: row.id, percentBp: row.percentBp, fixedCents: row.fixedCents } : null;
}

/** Комиссия по модели: процент от суммы, которую реально заплатил клиент, плюс фикс. */
export function estimateFeeCents(model: ResolvedFeeModel, customerPaidCents: number): number {
  return Math.round((customerPaidCents * model.percentBp) / 10000) + model.fixedCents;
}

export async function setFeeModel(args: {
  siteId: string;
  percentBp: number;
  fixedCents: number;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ id: string; previous: { percentBp: number; fixedCents: number } | null }> {
  assertOwner(args.actor);
  assertBp(args.percentBp, "Процент комиссии");
  assertNonNegativeInt(args.fixedCents, "Фиксированная часть комиссии");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.siteAcquiringFeeModel.findFirst({ where: { siteId: args.siteId } });

    const row = existing
      ? await tx.siteAcquiringFeeModel.update({
          where: { id: existing.id },
          data: { percentBp: args.percentBp, fixedCents: args.fixedCents, comment: args.comment ?? null },
          select: { id: true },
        })
      : await tx.siteAcquiringFeeModel.create({
          data: {
            siteId: args.siteId,
            percentBp: args.percentBp,
            fixedCents: args.fixedCents,
            comment: args.comment ?? null,
            createdBy: args.actor.userId,
          },
          select: { id: true },
        });

    await writeAudit(
      tx,
      "SiteAcquiringFeeModel",
      row.id,
      existing ? { percentBp: existing.percentBp, fixedCents: existing.fixedCents } : null,
      { percentBp: args.percentBp, fixedCents: args.fixedCents, siteId: args.siteId },
      args.actor,
      args.comment ?? null
    );

    return {
      id: row.id,
      previous: existing ? { percentBp: existing.percentBp, fixedCents: existing.fixedCents } : null,
    };
  });
}

// ───────────────────── Налоговая политика владельца ─────────────────────

export type ResolvedTaxPolicy = { policyId: string; actualShareBp: number };

/**
 * Доля Order.tax, считающаяся реальным расходом владельца.
 * ФЛОРИСТАМ не отдаётся никогда: в их базе налог вычитается на 100% независимо от политики.
 */
export async function resolveOwnerTaxPolicy(siteId: string): Promise<ResolvedTaxPolicy | null> {
  const rows = await prisma.ownerTaxPolicy.findMany({
    where: { OR: [{ siteId }, { siteId: null }] },
    select: { id: true, siteId: true, actualShareBp: true },
  });
  const site = rows.find((r) => r.siteId === siteId);
  if (site) return { policyId: site.id, actualShareBp: site.actualShareBp };
  const global = rows.find((r) => r.siteId === null);
  return global ? { policyId: global.id, actualShareBp: global.actualShareBp } : null;
}

export async function setOwnerTaxPolicy(args: {
  siteId: string | null;
  actualShareBp: number;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ id: string; previousBp: number | null }> {
  assertOwner(args.actor);
  assertBp(args.actualShareBp, "Доля налогового расхода");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.ownerTaxPolicy.findFirst({ where: { siteId: args.siteId } });

    const row = existing
      ? await tx.ownerTaxPolicy.update({
          where: { id: existing.id },
          data: { actualShareBp: args.actualShareBp, comment: args.comment ?? null },
          select: { id: true },
        })
      : await tx.ownerTaxPolicy.create({
          data: {
            siteId: args.siteId,
            actualShareBp: args.actualShareBp,
            comment: args.comment ?? null,
            createdBy: args.actor.userId,
          },
          select: { id: true },
        });

    await writeAudit(
      tx,
      "OwnerTaxPolicy",
      row.id,
      existing ? { actualShareBp: existing.actualShareBp } : null,
      { actualShareBp: args.actualShareBp, siteId: args.siteId },
      args.actor,
      args.comment ?? null
    );

    return { id: row.id, previousBp: existing?.actualShareBp ?? null };
  });
}

// ─────────────────────── Дневная закупка цветов ───────────────────────

/** Закупка за день у конкретного финансового профиля. NULL — не внесена. */
export async function resolveDailyFlowerExpense(
  financeProfileId: string,
  expenseDay: Date
): Promise<{ id: string; amountCents: number } | null> {
  const row = await prisma.dailyFlowerExpense.findUnique({
    where: { financeProfileId_expenseDay: { financeProfileId, expenseDay } },
    select: { id: true, amountCents: true },
  });
  return row;
}

/**
 * Вносит или исправляет дневную закупку. Это факт одного дня: правка на месте, прежнее
 * значение сохраняется в аудите, день пересчитывается.
 */
export async function setDailyFlowerExpense(args: {
  financeProfileId: string;
  expenseDay: Date;
  amountCents: number;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ id: string; previousCents: number | null }> {
  assertOwner(args.actor);
  assertNonNegativeInt(args.amountCents, "Расход на цветы");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.dailyFlowerExpense.findUnique({
      where: { financeProfileId_expenseDay: { financeProfileId: args.financeProfileId, expenseDay: args.expenseDay } },
    });

    const row = existing
      ? await tx.dailyFlowerExpense.update({
          where: { id: existing.id },
          data: { amountCents: args.amountCents, comment: args.comment ?? null },
          select: { id: true },
        })
      : await tx.dailyFlowerExpense.create({
          data: {
            financeProfileId: args.financeProfileId,
            expenseDay: args.expenseDay,
            amountCents: args.amountCents,
            comment: args.comment ?? null,
            createdBy: args.actor.userId,
          },
          select: { id: true },
        });

    await tx.financeAudit.create({
      data: {
        entity: "DailyFlowerExpense",
        entityId: row.id,
        action: existing ? "UPDATE_DAILY_FLOWER_EXPENSE" : "SET_DAILY_FLOWER_EXPENSE",
        beforeJson: existing ? { amountCents: existing.amountCents } : Prisma.JsonNull,
        afterJson: { amountCents: args.amountCents, expenseDay: args.expenseDay.toISOString() },
        reason: args.comment ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    return { id: row.id, previousCents: existing?.amountCents ?? null };
  });
}

// ─────────────────────────── Общее ───────────────────────────

async function writeAudit(
  tx: Prisma.TransactionClient,
  entity: string,
  entityId: string,
  before: Prisma.InputJsonValue | null,
  after: Prisma.InputJsonValue,
  actor: SettingsActor,
  comment: string | null
): Promise<void> {
  await tx.financeAudit.create({
    data: {
      entity,
      entityId,
      action: `SET_${entity}`,
      beforeJson: before ?? Prisma.JsonNull,
      afterJson: after,
      reason: comment,
      userId: actor.userId,
      role: actor.role,
    },
  });
}
