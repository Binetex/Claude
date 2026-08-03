import "server-only";
/**
 * Привязка вазы к букету. Единственный путь записи для карточки и для будущего bulk-review:
 * обе точки вызывают applyVariantVase/applyProductDefaultVase внутри своей транзакции.
 *
 * Состояния сохраняются атомарно и без противоречий:
 *   INHERIT     — includesVase = null,  ссылка = null (действует значение товара);
 *   NO_VASE     — includesVase = false, ссылка = null (товарный дефолт игнорируется);
 *   LINKED_VASE — includesVase = true,  ссылка обязательна.
 * Прежняя ссылка при переключении не остаётся «висеть»: её история сохраняется в FinanceAudit,
 * а текущее состояние всегда согласовано.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { effectiveFinancialType } from "./resolveVariantFinance";

export type VaseSelection =
  | { mode: "INHERIT" }
  | { mode: "NO_VASE" }
  | { mode: "LINKED_VASE"; vaseVariantId: string };

type CommonArgs = {
  actor: { userId: string; role: Role };
  reason?: string;
  batchId?: string;
};

function assertArgs(args: CommonArgs): void {
  if (args.actor.role !== "OWNER") throw new Error("вазы настраивает только владелец");
  if (args.batchId && !args.reason?.trim()) throw new Error("массовая операция требует причины");
}

/**
 * Проверяет, что на вазу вообще можно ссылаться: тот же магазин, эффективный тип VASE,
 * не архив, не сама позиция и не другой букет.
 */
async function assertLinkable(
  tx: Prisma.TransactionClient,
  args: { vaseVariantId: string; siteId: string; selfVariantId?: string }
): Promise<{ label: string }> {
  if (args.selfVariantId && args.selfVariantId === args.vaseVariantId) {
    throw new Error("нельзя привязать вариант к самому себе");
  }

  const vase = await tx.productVariant.findUnique({
    where: { id: args.vaseVariantId },
    select: {
      id: true,
      title: true,
      financialType: true,
      includedVaseVariantId: true,
      remoteDeleted: true,
      deletedAt: true,
      product: { select: { id: true, name: true, siteId: true, financialType: true } },
    },
  });
  if (!vase) throw new Error("ваза не найдена");

  if (vase.product.siteId !== args.siteId) {
    throw new Error("ваза должна принадлежать тому же магазину");
  }
  // Эффективный тип считает общий резолвер (вариант → товар → умолчание): проверять только
  // поле варианта нельзя, тип часто унаследован от товара. Умолчание — обычный букет,
  // поэтому вазой можно назначить лишь позицию, помеченную вазой явно.
  const effectiveType = effectiveFinancialType(vase.financialType, vase.product.financialType);
  if (effectiveType !== "VASE") {
    throw new Error("привязать можно только позицию с типом «Ваза»");
  }
  if (vase.remoteDeleted || vase.deletedAt) {
    throw new Error("нельзя привязать архивную вазу");
  }
  // Ваза сама ссылок иметь не может — этим исключаются цепочки и циклы.
  if (vase.includedVaseVariantId) {
    throw new Error("у вазы не может быть своей вложенной вазы");
  }

  return { label: `${vase.product.name}${vase.title !== "Default Title" ? ` / ${vase.title}` : ""}` };
}

export async function applyVariantVase(
  tx: Prisma.TransactionClient,
  args: CommonArgs & { variantId: string; selection: VaseSelection }
): Promise<void> {
  assertArgs(args);

  const variant = await tx.productVariant.findUnique({
    where: { id: args.variantId },
    select: {
      id: true,
      title: true,
      includesVase: true,
      includedVaseVariantId: true,
      product: { select: { id: true, name: true, siteId: true, site: { select: { shortName: true } } } },
    },
  });
  if (!variant) throw new Error("вариант не найден");

  let data: { includesVase: boolean | null; includedVaseVariantId: string | null };
  let vaseLabel: string | null = null;

  if (args.selection.mode === "INHERIT") {
    data = { includesVase: null, includedVaseVariantId: null };
  } else if (args.selection.mode === "NO_VASE") {
    data = { includesVase: false, includedVaseVariantId: null };
  } else {
    const { label } = await assertLinkable(tx, {
      vaseVariantId: args.selection.vaseVariantId,
      siteId: variant.product.siteId,
      selfVariantId: variant.id,
    });
    vaseLabel = label;
    data = { includesVase: true, includedVaseVariantId: args.selection.vaseVariantId };
  }

  if (variant.includesVase === data.includesVase && variant.includedVaseVariantId === data.includedVaseVariantId) {
    return;
  }

  await tx.productVariant.update({
    where: { id: args.variantId },
    data: { ...data, financialTypeSetBy: args.actor.userId, financialTypeSetAt: new Date() },
  });

  await tx.financeAudit.create({
    data: {
      entity: "ProductVariant",
      entityId: args.variantId,
      action: "SET_INCLUDED_VASE",
      // Прежняя ссылка живёт здесь — в текущем состоянии противоречий не остаётся.
      beforeJson: { includesVase: variant.includesVase, includedVaseVariantId: variant.includedVaseVariantId },
      afterJson: { ...data, mode: args.selection.mode, vaseLabel },
      reason: args.reason ?? null,
      batchId: args.batchId ?? null,
      entityNameSnapshot: `${variant.product.name} / ${variant.title}`,
      siteShortNameSnapshot: variant.product.site.shortName,
      userId: args.actor.userId,
      role: args.actor.role,
    },
  });
}

export async function applyProductDefaultVase(
  tx: Prisma.TransactionClient,
  args: CommonArgs & { productId: string; selection: VaseSelection }
): Promise<void> {
  assertArgs(args);

  const product = await tx.product.findUnique({
    where: { id: args.productId },
    select: {
      id: true,
      name: true,
      siteId: true,
      defaultIncludesVase: true,
      defaultIncludedVaseVariantId: true,
      site: { select: { shortName: true } },
    },
  });
  if (!product) throw new Error("товар не найден");

  let data: { defaultIncludesVase: boolean | null; defaultIncludedVaseVariantId: string | null };
  let vaseLabel: string | null = null;

  if (args.selection.mode === "INHERIT") {
    // Для товара это «не настроено».
    data = { defaultIncludesVase: null, defaultIncludedVaseVariantId: null };
  } else if (args.selection.mode === "NO_VASE") {
    data = { defaultIncludesVase: false, defaultIncludedVaseVariantId: null };
  } else {
    const { label } = await assertLinkable(tx, {
      vaseVariantId: args.selection.vaseVariantId,
      siteId: product.siteId,
    });
    vaseLabel = label;
    data = { defaultIncludesVase: true, defaultIncludedVaseVariantId: args.selection.vaseVariantId };
  }

  if (
    product.defaultIncludesVase === data.defaultIncludesVase &&
    product.defaultIncludedVaseVariantId === data.defaultIncludedVaseVariantId
  ) {
    return;
  }

  await tx.product.update({ where: { id: args.productId }, data });

  await tx.financeAudit.create({
    data: {
      entity: "Product",
      entityId: args.productId,
      action: "SET_INCLUDED_VASE",
      beforeJson: {
        defaultIncludesVase: product.defaultIncludesVase,
        defaultIncludedVaseVariantId: product.defaultIncludedVaseVariantId,
      },
      afterJson: { ...data, mode: args.selection.mode, vaseLabel },
      reason: args.reason ?? null,
      batchId: args.batchId ?? null,
      entityNameSnapshot: product.name,
      siteShortNameSnapshot: product.site.shortName,
      userId: args.actor.userId,
      role: args.actor.role,
    },
  });
}

export async function setVariantVase(args: CommonArgs & { variantId: string; selection: VaseSelection }): Promise<void> {
  await prisma.$transaction((tx) => applyVariantVase(tx, args));
}

export async function setProductDefaultVase(
  args: CommonArgs & { productId: string; selection: VaseSelection }
): Promise<void> {
  await prisma.$transaction((tx) => applyProductDefaultVase(tx, args));
}

/** Активные вазы магазина для селектора: эффективный тип VASE, не архив. */
export async function listVaseOptions(siteId: string): Promise<
  { id: string; label: string; productId: string; costCents: number | null; isDraft: boolean }[]
> {
  const variants = await prisma.productVariant.findMany({
    where: {
      remoteDeleted: false,
      deletedAt: null,
      product: { siteId, remoteDeleted: false, deletedAt: null },
      OR: [{ financialType: "VASE" }, { financialType: null, product: { financialType: "VASE" } }],
    },
    select: {
      id: true,
      title: true,
      product: {
        select: {
          id: true,
          name: true,
          status: true,
          // Стоимость вазы чаще всего задают на карточке ТОВАРА, а не варианта. Без этой
          // выборки список показывал «закуп не указан» у вазы, которой цена уже задана.
          vaseCosts: { where: { costType: "STANDALONE_VASE" } },
        },
      },
      vaseCosts: { where: { costType: "STANDALONE_VASE" } },
    },
    orderBy: [{ product: { name: "asc" } }, { title: "asc" }],
  });

  return variants.map((v) => {
    // Тот же приоритет, что и в расчёте заказа: своя цена варианта, иначе цена товара.
    const active = v.vaseCosts[0] ?? v.product.vaseCosts[0] ?? null;
    return {
      id: v.id,
      productId: v.product.id,
      label: `${v.product.name}${v.title !== "Default Title" ? ` / ${v.title}` : ""}`,
      costCents: active?.purchaseCostCents ?? null,
      // Черновик магазина остаётся полноценной вазой для учёта — но владельцу стоит видеть,
      // что товар не опубликован.
      isDraft: v.product.status === "DRAFT",
    };
  });
}
