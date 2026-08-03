import "server-only";
/**
 * Изменение закупочной себестоимости вазы. Единственный путь записи в VasePurchaseCost.
 *
 * Одна строка на цель и тип: правка переписывает значение. Периодов действия нет —
 * подорожание вазы это просто новая сумма, а не новый интервал. История сумм остаётся в
 * `FinanceAudit`, где у каждой правки есть автор, время и причина.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role, VaseCostType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";

export type VaseCostTarget = { productId: string } | { productVariantId: string };

export type SetVasePurchaseCostArgs = {
  target: VaseCostTarget;
  costType: VaseCostType;
  purchaseCostCents: number;
  actor: { userId: string; role: Role };
  /** Обязателен для массовых операций: без него bulk не пишется. */
  reason?: string;
  batchId?: string;
  comment?: string;
  /** Снимки названий для читаемого аудита после исчезновения товара с платформы. */
  entityNameSnapshot?: string;
  siteShortNameSnapshot?: string;
};

export type SetVasePurchaseCostResult = { id: string; previousCents: number | null };

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

  const where = targetWhere(args.target);
  const { entity, entityId } = targetEntity(args.target);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vasePurchaseCost.findFirst({ where: { ...where, costType: args.costType } });

    const row = existing
      ? await tx.vasePurchaseCost.update({
          where: { id: existing.id },
          data: { purchaseCostCents: args.purchaseCostCents, comment: args.comment ?? null },
          select: { id: true },
        })
      : await tx.vasePurchaseCost.create({
          data: {
            ...where,
            costType: args.costType,
            purchaseCostCents: args.purchaseCostCents,
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
        beforeJson: existing
          ? { costRecordId: existing.id, costType: existing.costType, purchaseCostCents: existing.purchaseCostCents }
          : Prisma.JsonNull,
        afterJson: { costRecordId: row.id, costType: args.costType, purchaseCostCents: args.purchaseCostCents },
        reason: args.reason ?? null,
        batchId: args.batchId ?? null,
        entityNameSnapshot: args.entityNameSnapshot ?? null,
        siteShortNameSnapshot: args.siteShortNameSnapshot ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    return { id: row.id, previousCents: existing?.purchaseCostCents ?? null };
  });
}

/**
 * Удаление ошибочно заведённой стоимости.
 *
 * После удаления стоимость становится неизвестной, и позиции, которым она обязательна,
 * попадают в разбор. Это правильнее подстановки нуля: ноль означал бы «ваза досталась
 * бесплатно» и завысил бы прибыль.
 */
export async function deleteVasePurchaseCost(args: {
  costId: string;
  actor: { userId: string; role: Role };
  reason?: string;
}): Promise<void> {
  if (args.actor.role !== "OWNER") throw new Error("стоимость правит только владелец");

  await prisma.$transaction(async (tx) => {
    const current = await tx.vasePurchaseCost.findUnique({ where: { id: args.costId } });
    if (!current) throw new Error("запись стоимости не найдена");

    await tx.vasePurchaseCost.delete({ where: { id: args.costId } });

    await tx.financeAudit.create({
      data: {
        entity: current.productVariantId ? "ProductVariant" : "Product",
        entityId: current.productVariantId ?? current.productId!,
        action: "DELETE_COST",
        // Удалённая строка целиком остаётся в аудите — сама операция не теряется.
        beforeJson: { costRecordId: current.id, purchaseCostCents: current.purchaseCostCents },
        afterJson: Prisma.JsonNull,
        reason: args.reason ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });
}
