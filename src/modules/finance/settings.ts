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

const EXCLUSION_VIOLATION = "23P01";

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

/** Общий предикат «действует на дату» для effective-dated настроек. */
function activeAt(at: Date) {
  return { effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] };
}

// ─────────────────────────── Расходники ───────────────────────────

export type ResolvedConsumables = { amountCents: number; rateId: string; scope: "SITE" | "GLOBAL" };

/**
 * Ставка расходников на дату: настройка магазина приоритетнее глобальной.
 * NULL — ставка не задана, и заказ в расчёт не попадёт.
 */
export async function resolveConsumablesRate(siteId: string, at: Date): Promise<ResolvedConsumables | null> {
  const rows = await prisma.consumablesRate.findMany({
    where: { AND: [activeAt(at), { OR: [{ siteId }, { siteId: null }] }] },
    select: { id: true, siteId: true, amountCents: true },
  });
  const site = rows.find((r) => r.siteId === siteId);
  if (site) return { amountCents: site.amountCents, rateId: site.id, scope: "SITE" };
  const global = rows.find((r) => r.siteId === null);
  return global ? { amountCents: global.amountCents, rateId: global.id, scope: "GLOBAL" } : null;
}

export async function setConsumablesRate(args: {
  siteId: string | null;
  amountCents: number;
  effectiveFrom: Date;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ closedId: string | null; createdId: string }> {
  assertOwner(args.actor);
  assertNonNegativeInt(args.amountCents, "Ставка расходников");

  return retryOnOverlap(() =>
    prisma.$transaction(async (tx) => {
      const active = await tx.consumablesRate.findFirst({
        where: { siteId: args.siteId, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      assertLater(active, args.effectiveFrom);

      let closedId: string | null = null;
      if (active) {
        await tx.consumablesRate.update({ where: { id: active.id }, data: { effectiveTo: args.effectiveFrom } });
        closedId = active.id;
      }

      const created = await tx.consumablesRate.create({
        data: {
          siteId: args.siteId,
          amountCents: args.amountCents,
          effectiveFrom: args.effectiveFrom,
          comment: args.comment ?? null,
          createdBy: args.actor.userId,
        },
        select: { id: true },
      });

      await writeAudit(
        tx,
        "ConsumablesRate",
        created.id,
        active ? { amountCents: active.amountCents } : null,
        { amountCents: args.amountCents, siteId: args.siteId, effectiveFrom: args.effectiveFrom.toISOString() },
        args.actor,
        args.comment ?? null
      );

      return { closedId, createdId: created.id };
    })
  );
}

// ─────────────────────── Комиссия эквайринга ───────────────────────

export type ResolvedFeeModel = { modelId: string; percentBp: number; fixedCents: number };

export async function resolveFeeModel(siteId: string, at: Date): Promise<ResolvedFeeModel | null> {
  const row = await prisma.siteAcquiringFeeModel.findFirst({
    where: { siteId, ...activeAt(at) },
    orderBy: { effectiveFrom: "desc" },
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
  effectiveFrom: Date;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ closedId: string | null; createdId: string }> {
  assertOwner(args.actor);
  assertBp(args.percentBp, "Процент комиссии");
  assertNonNegativeInt(args.fixedCents, "Фиксированная часть комиссии");

  return retryOnOverlap(() =>
    prisma.$transaction(async (tx) => {
      const active = await tx.siteAcquiringFeeModel.findFirst({
        where: { siteId: args.siteId, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      assertLater(active, args.effectiveFrom);

      let closedId: string | null = null;
      if (active) {
        await tx.siteAcquiringFeeModel.update({ where: { id: active.id }, data: { effectiveTo: args.effectiveFrom } });
        closedId = active.id;
      }

      const created = await tx.siteAcquiringFeeModel.create({
        data: {
          siteId: args.siteId,
          percentBp: args.percentBp,
          fixedCents: args.fixedCents,
          effectiveFrom: args.effectiveFrom,
          comment: args.comment ?? null,
          createdBy: args.actor.userId,
        },
        select: { id: true },
      });

      await writeAudit(
        tx,
        "SiteAcquiringFeeModel",
        created.id,
        active ? { percentBp: active.percentBp, fixedCents: active.fixedCents } : null,
        {
          percentBp: args.percentBp,
          fixedCents: args.fixedCents,
          siteId: args.siteId,
          effectiveFrom: args.effectiveFrom.toISOString(),
        },
        args.actor,
        args.comment ?? null
      );

      return { closedId, createdId: created.id };
    })
  );
}

// ───────────────────── Налоговая политика владельца ─────────────────────

export type ResolvedTaxPolicy = { policyId: string; actualShareBp: number };

/**
 * Доля Order.tax, считающаяся реальным расходом владельца.
 * ФЛОРИСТАМ не отдаётся никогда: в их базе налог вычитается на 100% независимо от политики.
 */
export async function resolveOwnerTaxPolicy(siteId: string, at: Date): Promise<ResolvedTaxPolicy | null> {
  const rows = await prisma.ownerTaxPolicy.findMany({
    where: { AND: [activeAt(at), { OR: [{ siteId }, { siteId: null }] }] },
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
  effectiveFrom: Date;
  comment?: string | null;
  actor: SettingsActor;
}): Promise<{ closedId: string | null; createdId: string }> {
  assertOwner(args.actor);
  assertBp(args.actualShareBp, "Доля налогового расхода");

  return retryOnOverlap(() =>
    prisma.$transaction(async (tx) => {
      const active = await tx.ownerTaxPolicy.findFirst({
        where: { siteId: args.siteId, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      assertLater(active, args.effectiveFrom);

      let closedId: string | null = null;
      if (active) {
        await tx.ownerTaxPolicy.update({ where: { id: active.id }, data: { effectiveTo: args.effectiveFrom } });
        closedId = active.id;
      }

      const created = await tx.ownerTaxPolicy.create({
        data: {
          siteId: args.siteId,
          actualShareBp: args.actualShareBp,
          effectiveFrom: args.effectiveFrom,
          comment: args.comment ?? null,
          createdBy: args.actor.userId,
        },
        select: { id: true },
      });

      await writeAudit(
        tx,
        "OwnerTaxPolicy",
        created.id,
        active ? { actualShareBp: active.actualShareBp } : null,
        { actualShareBp: args.actualShareBp, siteId: args.siteId, effectiveFrom: args.effectiveFrom.toISOString() },
        args.actor,
        args.comment ?? null
      );

      return { closedId, createdId: created.id };
    })
  );
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
 * Вносит или исправляет дневную закупку. В отличие от effective-dated настроек здесь
 * правка на месте допустима: это факт одного дня, а не период действия. Прежнее значение
 * сохраняется в аудите, а снимки дня пересобираются новой ревизией.
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

/**
 * Проверка «новый период начинается позже текущего». Одинакова у всех трёх настроек,
 * а вот сама смена периода написана для каждой отдельно: обобщать её через
 * Prisma-делегат пришлось бы небезопасными приведениями типов, и ошибка в поле
 * перестала бы ловиться компилятором.
 */
function assertLater(active: { effectiveFrom: Date } | null, effectiveFrom: Date): void {
  if (active && active.effectiveFrom.getTime() >= effectiveFrom.getTime()) {
    throw new FinanceSettingsError(
      "bad_period",
      `Новое значение должно действовать позже текущего (текущее — с ${active.effectiveFrom.toISOString().slice(0, 10)}).`
    );
  }
}

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

/** Гонку выигрывает первая транзакция; проигравшая перечитывает состояние и повторяет. */
async function retryOnOverlap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const isExclusion =
      (err instanceof Prisma.PrismaClientKnownRequestError && err.meta?.code === EXCLUSION_VIOLATION) ||
      (err instanceof Prisma.PrismaClientUnknownRequestError && String(err.message).includes(EXCLUSION_VIOLATION));
    if (isExclusion) return await run();
    throw err;
  }
}
