import "server-only";
/**
 * Изменение закупочной себестоимости вазы. Единственный путь записи в VasePurchaseCost.
 *
 * Одна транзакция: закрыть текущий активный интервал → открыть новый → записать аудит.
 * Пересечения периодов дополнительно запрещены exclusion-constraint'ом в БД, поэтому
 * при гонке проигравшая транзакция получает 23P01 — её повторяем один раз.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role, VaseCostType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";

/** Postgres: нарушение exclusion-constraint (пересечение интервалов). */
const EXCLUSION_VIOLATION = "23P01";

export type VaseCostTarget = { productId: string } | { productVariantId: string };

export type SetVasePurchaseCostArgs = {
  target: VaseCostTarget;
  costType: VaseCostType;
  purchaseCostCents: number;
  effectiveFrom: Date;
  actor: { userId: string; role: Role };
  /** Обязателен для массовых операций: без него bulk не пишется. */
  reason?: string;
  batchId?: string;
  comment?: string;
  /** Снимки названий для читаемого аудита после исчезновения товара с платформы. */
  entityNameSnapshot?: string;
  siteShortNameSnapshot?: string;
};

export type SetVasePurchaseCostResult = { closedId: string | null; createdId: string };

function targetWhere(target: VaseCostTarget) {
  return "productId" in target
    ? { productId: target.productId, productVariantId: null }
    : { productVariantId: target.productVariantId, productId: null };
}

function targetEntity(target: VaseCostTarget): { entity: string; entityId: string } {
  return "productId" in target
    ? { entity: "Product", entityId: target.productId }
    : { entity: "ProductVariant", entityId: target.productVariantId };
}

export async function setVasePurchaseCost(args: SetVasePurchaseCostArgs): Promise<SetVasePurchaseCostResult> {
  if (!Number.isInteger(args.purchaseCostCents) || args.purchaseCostCents < 0) {
    throw new Error("purchaseCostCents должен быть целым неотрицательным числом центов");
  }
  if (args.batchId && !args.reason?.trim()) {
    throw new Error("массовая операция требует причины");
  }

  try {
    return await runOnce(args);
  } catch (err) {
    // Гонку выигрывает первая транзакция; вторая перечитывает состояние и повторяет.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.meta?.code === EXCLUSION_VIOLATION) {
      return await runOnce(args);
    }
    if (err instanceof Prisma.PrismaClientUnknownRequestError && String(err.message).includes(EXCLUSION_VIOLATION)) {
      return await runOnce(args);
    }
    throw err;
  }
}

async function runOnce(args: SetVasePurchaseCostArgs): Promise<SetVasePurchaseCostResult> {
  const where = targetWhere(args.target);
  const { entity, entityId } = targetEntity(args.target);

  return prisma.$transaction(async (tx) => {
    // Блокируем цель, чтобы параллельная запись по тому же товару/варианту ждала.
    const active = await tx.vasePurchaseCost.findFirst({
      where: { ...where, costType: args.costType, effectiveTo: null },
      orderBy: { effectiveFrom: "desc" },
    });

    let closedId: string | null = null;
    if (active) {
      if (active.effectiveFrom.getTime() >= args.effectiveFrom.getTime()) {
        throw new Error(
          "новая стоимость должна действовать позже текущей: закрываемый интервал начался " +
            active.effectiveFrom.toISOString()
        );
      }
      // Полуинтервал [from, to): конец предыдущего периода совпадает с началом нового.
      await tx.vasePurchaseCost.update({
        where: { id: active.id },
        data: { effectiveTo: args.effectiveFrom },
      });
      closedId = active.id;
    }

    const created = await tx.vasePurchaseCost.create({
      data: {
        ...where,
        costType: args.costType,
        purchaseCostCents: args.purchaseCostCents,
        effectiveFrom: args.effectiveFrom,
        comment: args.comment ?? null,
        createdBy: args.actor.userId,
      },
      select: { id: true },
    });

    await tx.financeAudit.create({
      data: {
        entity,
        entityId,
        action: "SET_COST",
        beforeJson: active
          ? {
              costRecordId: active.id,
              costType: active.costType,
              purchaseCostCents: active.purchaseCostCents,
              effectiveFrom: active.effectiveFrom.toISOString(),
            }
          : Prisma.JsonNull,
        afterJson: {
          costRecordId: created.id,
          costType: args.costType,
          purchaseCostCents: args.purchaseCostCents,
          effectiveFrom: args.effectiveFrom.toISOString(),
        },
        reason: args.reason ?? null,
        batchId: args.batchId ?? null,
        entityNameSnapshot: args.entityNameSnapshot ?? null,
        siteShortNameSnapshot: args.siteShortNameSnapshot ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    return { closedId, createdId: created.id };
  });
}
