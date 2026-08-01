import "server-only";
/**
 * Финансовая классификация каталога: тип позиции и признак вазы.
 *
 * ЕДИНСТВЕННЫЙ путь записи для обоих сценариев — обычное редактирование карточки и будущий
 * bulk-review. Bulk открывает одну транзакцию и вызывает те же apply*-функции с общим batchId,
 * поэтому второй формулы сохранения не существует.
 *
 * NULL везде означает «наследовать/не задано», а не «ложь». Явный false — подтверждённое
 * отсутствие вазы; это разные состояния, и они не схлопываются.
 */
import { Prisma } from "@/generated/prisma/client";
import type { FinancialItemType, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";

export type ClassificationActor = { userId: string; role: Role };

export type VariantClassificationPatch = {
  /** undefined — не трогать поле; null — вернуть наследование; значение — переопределить. */
  financialType?: FinancialItemType | null;
  includesVase?: boolean | null;
};

export type ProductClassificationPatch = {
  financialType?: FinancialItemType | null;
  defaultIncludesVase?: boolean | null;
};

type CommonArgs = {
  actor: ClassificationActor;
  /** Обязателен для массовых операций. */
  reason?: string;
  batchId?: string;
};

/** Общая валидация обоих путей записи. */
function assertArgs(args: CommonArgs): void {
  if (args.actor.role !== "OWNER") throw new Error("классификацию каталога меняет только владелец");
  if (args.batchId && !args.reason?.trim()) throw new Error("массовая операция требует причины");
}

/** Только реально изменившиеся поля — чтобы аудит не пух от no-op правок. */
function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && before[k as keyof T] !== v) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

export async function applyVariantClassification(
  tx: Prisma.TransactionClient,
  args: CommonArgs & { variantId: string; patch: VariantClassificationPatch }
): Promise<boolean> {
  assertArgs(args);
  const variant = await tx.productVariant.findUnique({
    where: { id: args.variantId },
    select: {
      id: true,
      title: true,
      financialType: true,
      includesVase: true,
      product: { select: { name: true, site: { select: { shortName: true } } } },
    },
  });
  if (!variant) throw new Error("вариант не найден");

  const changes = diff(
    { financialType: variant.financialType, includesVase: variant.includesVase },
    args.patch
  );
  if (Object.keys(changes).length === 0) return false;

  await tx.productVariant.update({
    where: { id: args.variantId },
    data: { ...changes, financialTypeSetBy: args.actor.userId, financialTypeSetAt: new Date() },
  });

  await tx.financeAudit.create({
    data: {
      entity: "ProductVariant",
      entityId: args.variantId,
      action: Object.keys(changes).includes("financialType") ? "SET_TYPE" : "SET_INCLUDES_VASE",
      beforeJson: { financialType: variant.financialType, includesVase: variant.includesVase },
      afterJson: { ...changes },
      reason: args.reason ?? null,
      batchId: args.batchId ?? null,
      entityNameSnapshot: `${variant.product.name} / ${variant.title}`,
      siteShortNameSnapshot: variant.product.site.shortName,
      userId: args.actor.userId,
      role: args.actor.role,
    },
  });
  return true;
}

export async function applyProductClassification(
  tx: Prisma.TransactionClient,
  args: CommonArgs & { productId: string; patch: ProductClassificationPatch }
): Promise<boolean> {
  assertArgs(args);
  const product = await tx.product.findUnique({
    where: { id: args.productId },
    select: { id: true, name: true, financialType: true, defaultIncludesVase: true, site: { select: { shortName: true } } },
  });
  if (!product) throw new Error("товар не найден");

  const changes = diff(
    { financialType: product.financialType, defaultIncludesVase: product.defaultIncludesVase },
    args.patch
  );
  if (Object.keys(changes).length === 0) return false;

  await tx.product.update({ where: { id: args.productId }, data: changes });

  await tx.financeAudit.create({
    data: {
      entity: "Product",
      entityId: args.productId,
      action: Object.keys(changes).includes("financialType") ? "SET_TYPE" : "SET_INCLUDES_VASE",
      beforeJson: { financialType: product.financialType, defaultIncludesVase: product.defaultIncludesVase },
      afterJson: { ...changes },
      reason: args.reason ?? null,
      batchId: args.batchId ?? null,
      entityNameSnapshot: product.name,
      siteShortNameSnapshot: product.site.shortName,
      userId: args.actor.userId,
      role: args.actor.role,
    },
  });
  return true;
}

/** Обычное редактирование одного варианта. Bulk использует applyVariantClassification напрямую. */
export async function setVariantClassification(
  args: CommonArgs & { variantId: string; patch: VariantClassificationPatch }
): Promise<void> {
  await prisma.$transaction((tx) => applyVariantClassification(tx, args));
}

/** Обычное редактирование одного товара. */
export async function setProductClassification(
  args: CommonArgs & { productId: string; patch: ProductClassificationPatch }
): Promise<void> {
  await prisma.$transaction((tx) => applyProductClassification(tx, args));
}
