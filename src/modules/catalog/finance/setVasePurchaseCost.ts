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

/**
 * Исправление уже сохранённого интервала — для опечаток, а не для истории цен.
 *
 * Разница принципиальная: подорожание оформляется НОВЫМ интервалом (setVasePurchaseCost),
 * а неверно введённая сумма правится здесь. Иначе ошибку невозможно убрать: она продолжает
 * действовать на свой период, а новый интервал с той же датой начала создать нельзя.
 *
 * Сама правка не теряется — before/after уходит в FinanceAudit. Когда появятся финансовые
 * снимки заказов, ссылающиеся на конкретную запись стоимости, здесь добавится запрет на
 * правку уже использованных интервалов: пересчитывать закрытый период нельзя.
 */
export async function updateVasePurchaseCost(args: {
  costId: string;
  purchaseCostCents?: number;
  effectiveFrom?: Date;
  comment?: string | null;
  actor: { userId: string; role: Role };
  reason?: string;
}): Promise<void> {
  if (args.actor.role !== "OWNER") throw new Error("стоимость правит только владелец");
  if (args.purchaseCostCents != null && (!Number.isInteger(args.purchaseCostCents) || args.purchaseCostCents < 0)) {
    throw new Error("сумма должна быть целым неотрицательным числом центов");
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.vasePurchaseCost.findUnique({ where: { id: args.costId } });
    if (!current) throw new Error("запись стоимости не найдена");

    // Если сдвигаем начало, двигаем и конец предыдущего интервала — иначе в истории
    // появится дыра, в которой стоимость «неизвестна».
    if (args.effectiveFrom && args.effectiveFrom.getTime() !== current.effectiveFrom.getTime()) {
      if (current.effectiveTo && args.effectiveFrom >= current.effectiveTo) {
        throw new Error("начало интервала должно быть раньше его окончания");
      }
      const previous = await tx.vasePurchaseCost.findFirst({
        where: {
          costType: current.costType,
          productId: current.productId,
          productVariantId: current.productVariantId,
          effectiveTo: current.effectiveFrom,
        },
      });
      if (previous) {
        await tx.vasePurchaseCost.update({ where: { id: previous.id }, data: { effectiveTo: args.effectiveFrom } });
      }
    }

    const updated = await tx.vasePurchaseCost.update({
      where: { id: args.costId },
      data: {
        ...(args.purchaseCostCents != null ? { purchaseCostCents: args.purchaseCostCents } : {}),
        ...(args.effectiveFrom ? { effectiveFrom: args.effectiveFrom } : {}),
        ...(args.comment !== undefined ? { comment: args.comment } : {}),
      },
    });

    await tx.financeAudit.create({
      data: {
        entity: current.productVariantId ? "ProductVariant" : "Product",
        entityId: current.productVariantId ?? current.productId!,
        action: "CORRECT_COST",
        beforeJson: {
          costRecordId: current.id,
          purchaseCostCents: current.purchaseCostCents,
          effectiveFrom: current.effectiveFrom.toISOString(),
        },
        afterJson: {
          costRecordId: updated.id,
          purchaseCostCents: updated.purchaseCostCents,
          effectiveFrom: updated.effectiveFrom.toISOString(),
        },
        reason: args.reason ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });
}

/**
 * Удаление ошибочного интервала. Предыдущий интервал при этом снова «дотягивается» до конца
 * удаляемого, чтобы в истории не осталось периода без стоимости.
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

    const previous = await tx.vasePurchaseCost.findFirst({
      where: {
        costType: current.costType,
        productId: current.productId,
        productVariantId: current.productVariantId,
        effectiveTo: current.effectiveFrom,
      },
    });

    await tx.vasePurchaseCost.delete({ where: { id: args.costId } });
    if (previous) {
      await tx.vasePurchaseCost.update({ where: { id: previous.id }, data: { effectiveTo: current.effectiveTo } });
    }

    await tx.financeAudit.create({
      data: {
        entity: current.productVariantId ? "ProductVariant" : "Product",
        entityId: current.productVariantId ?? current.productId!,
        action: "DELETE_COST",
        // Удалённая строка целиком остаётся в аудите — сама операция не теряется.
        beforeJson: {
          costRecordId: current.id,
          purchaseCostCents: current.purchaseCostCents,
          effectiveFrom: current.effectiveFrom.toISOString(),
          effectiveTo: current.effectiveTo ? current.effectiveTo.toISOString() : null,
        },
        afterJson: Prisma.JsonNull,
        reason: args.reason ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });
}
