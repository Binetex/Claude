import "server-only";
/**
 * Финансовая сторона позиций заказа: тип позиции и её закупочная стоимость.
 *
 * Вынесено отдельным модулем, потому что переживает сборщик снимков: расчёт дня больше не
 * раскладывает закупку цветов по заказам, но закупочную стоимость ваз и подарков
 * по-прежнему считает автоматически — ради неё каталог и нужен.
 *
 * Резолвится ПАЧКОЙ на все позиции сразу: вызов на каждый заказ был честным N+1.
 */
import type { FinancialItemType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { isTipItem } from "@/modules/pricing/serviceItems";
import { effectiveFinancialType, resolveVariantFinance, type VaseCostRow } from "@/modules/catalog/finance/resolveVariantFinance";

export type ItemFinance = {
  isTip: boolean;
  financialType: FinancialItemType | null;
  /** Позиции этого типа обязаны иметь закупочную стоимость. */
  costRequired: boolean;
  purchaseCostCents: number | null;
  purchaseCostRecordId: string | null;
  reasons: string[];
};

/**
 * Классификация и закупочная стоимость позиций заказа.
 * Резолв целиком делегирован Stage 1 (`resolveVariantFinance`) — второй формулы нет.
 */
export async function resolveItemsFinance(
  items: Array<{ id: string; name: string; productId: string | null; variantId: string | null }>
): Promise<Map<string, ItemFinance>> {
  const result = new Map<string, ItemFinance>();

  const variantIds = [...new Set(items.map((i) => i.variantId).filter((x): x is string => !!x))];
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];

  const variants = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          productId: true,
          title: true,
          financialType: true,
          includesVase: true,
          includedVaseVariantId: true,
          remoteDeleted: true,
          product: {
            select: { id: true, name: true, financialType: true, defaultIncludesVase: true, defaultIncludedVaseVariantId: true },
          },
        },
      })
    : [];

  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, financialType: true, defaultIncludesVase: true, defaultIncludedVaseVariantId: true },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  // Связанные вазы: их тип и собственная закупка нужны для букетов «с вазой».
  const linkedVaseIds = [
    ...new Set(
      variants.flatMap((v) => [v.includedVaseVariantId, v.product.defaultIncludedVaseVariantId].filter((x): x is string => !!x))
    ),
  ];
  const linkedVases = linkedVaseIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: linkedVaseIds } },
        select: {
          id: true,
          productId: true,
          title: true,
          remoteDeleted: true,
          financialType: true,
          product: { select: { name: true, financialType: true } },
        },
      })
    : [];

  const costTargets = [...new Set([...variantIds, ...linkedVaseIds])];
  // ТОВАРЫ связанных ваз обязаны попасть в выборку: стоимость вазы часто задана на карточке
  // товара, а не на конкретном варианте, и резолв Stage 1 ищет её именно там
  // (`pick(r.productId === linked.productId)`). Без них у букета с вазой стоимость выглядела
  // бы отсутствующей, хотя она задана, и заказ молча выпадал бы из расчёта.
  const costProductIds = [...new Set([...productIds, ...linkedVases.map((v) => v.productId)])];
  const costs = costTargets.length || costProductIds.length
    ? await prisma.vasePurchaseCost.findMany({
        where: { OR: [{ productVariantId: { in: costTargets } }, { productId: { in: costProductIds } }] },
        select: {
          id: true,
          productId: true,
          productVariantId: true,
          costType: true,
          purchaseCostCents: true,
        },
      })
    : [];

  const vaseInfo: Record<string, { id: string; productId: string; effectiveType: typeof linkedVases[number]["financialType"]; archived: boolean; label: string }> = {};
  for (const v of linkedVases) {
    vaseInfo[v.id] = {
      id: v.id,
      productId: v.productId,
      effectiveType: v.financialType ?? v.product.financialType,
      archived: v.remoteDeleted,
      label: `${v.product.name} — ${v.title}`,
    };
  }

  for (const item of items) {
    if (isTipItem(item)) {
      result.set(item.id, { isTip: true, financialType: null, costRequired: false, purchaseCostCents: null, purchaseCostRecordId: null, reasons: [] });
      continue;
    }

    const variant = item.variantId ? variants.find((v) => v.id === item.variantId) : undefined;
    if (variant) {
      const finance = resolveVariantFinance({
        variant: {
          id: variant.id,
          financialType: variant.financialType,
          includesVase: variant.includesVase,
          includedVaseVariantId: variant.includedVaseVariantId,
        },
        product: {
          id: variant.product.id,
          financialType: variant.product.financialType,
          defaultIncludesVase: variant.product.defaultIncludesVase,
          defaultIncludedVaseVariantId: variant.product.defaultIncludedVaseVariantId,
        },
        costs: costs as VaseCostRow[],
        vases: vaseInfo,
      });
      // Закупка обязательна там, где позиция не является обычным букетом без вазы:
      // именно эти случаи Stage 1 помечает причинами разбора.
      result.set(item.id, {
        isTip: false,
        financialType: finance.financialType,
        costRequired: finance.reviewReasons.length > 0 || finance.purchaseCostCents != null,
        purchaseCostCents: finance.purchaseCostCents,
        purchaseCostRecordId: finance.purchaseCostRecordId,
        reasons: finance.reviewReasons,
      });
      continue;
    }

    const product = item.productId ? productById.get(item.productId) : undefined;
    if (product) {
      result.set(item.id, {
        isTip: false,
        financialType: effectiveFinancialType(null, product.financialType),
        costRequired: false,
        purchaseCostCents: null,
        purchaseCostRecordId: null,
        reasons: [],
      });
      continue;
    }

    // Ни варианта, ни товара: чем является позиция — неизвестно. Знаменатель дня
    // становится недостоверным, и это отдельная блокирующая проблема.
    result.set(item.id, {
      isTip: false,
      financialType: null,
      costRequired: false,
      purchaseCostCents: null,
      purchaseCostRecordId: null,
      reasons: ["ITEM_NOT_IN_CATALOG"],
    });
  }

  return result;
}
