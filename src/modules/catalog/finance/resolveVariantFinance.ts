/**
 * Резолв финансовых свойств позиции каталога: тип, признак вазы и её закупочная себестоимость.
 *
 * Чистая функция без Prisma и без «сейчас»: дата передаётся снаружи — это дата доставки заказа
 * в таймзоне магазина. Поэтому изменение прайса сегодня не меняет расчёт вчерашнего заказа.
 *
 * Три состояния каждого свойства не схлопываются:
 *   inherited — своего значения нет, действует значение товара;
 *   override  — задано на варианте (в том числе false);
 *   unknown   — не задано нигде.
 *
 * Цена клиента (listPrice) себестоимостью не становится ни в одной ветке — она сюда не приходит.
 */
import type { FinancialItemType, VaseCostType } from "@/generated/prisma/enums";

export type EffectiveSource = "VARIANT" | "PRODUCT" | "UNKNOWN";

export type VaseCostRow = {
  id: string;
  productId: string | null;
  productVariantId: string | null;
  costType: VaseCostType;
  purchaseCostCents: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type VariantFinanceInput = {
  variant: { id: string; financialType: FinancialItemType | null; includesVase: boolean | null };
  product: { id: string; financialType: FinancialItemType | null; defaultIncludesVase: boolean | null };
  /** Все строки стоимости по этому варианту и его товару, любых costType и периодов. */
  costs: VaseCostRow[];
  at: Date;
};

export type CatalogReviewReason = "ITEM_UNCLASSIFIED" | "VASE_COST_MISSING";

export type VariantFinance = {
  financialType: FinancialItemType | null;
  financialTypeSource: EffectiveSource;
  includesVase: boolean | null;
  includesVaseSource: EffectiveSource;
  vaseCostCents: number | null;
  vaseCostType: VaseCostType | null;
  vaseCostSource: EffectiveSource;
  /** Какая именно строка применена — попадёт в CalcInput финансового снимка. */
  vaseCostRecordId: string | null;
  reviewReasons: CatalogReviewReason[];
};

/** Активна ли строка на дату: полуинтервал [from, to). */
function isActiveAt(row: VaseCostRow, at: Date): boolean {
  if (row.effectiveFrom.getTime() > at.getTime()) return false;
  return row.effectiveTo === null || row.effectiveTo.getTime() > at.getTime();
}

/** Строка стоимости для цели и типа на дату. Пересечений быть не может — их запрещает БД. */
function pick(
  costs: VaseCostRow[],
  costType: VaseCostType,
  at: Date,
  match: (row: VaseCostRow) => boolean
): VaseCostRow | null {
  return costs.find((r) => r.costType === costType && match(r) && isActiveAt(r, at)) ?? null;
}

export function resolveVariantFinance(input: VariantFinanceInput): VariantFinance {
  const { variant, product, costs, at } = input;

  const financialType = variant.financialType ?? product.financialType ?? null;
  const financialTypeSource: EffectiveSource =
    variant.financialType != null ? "VARIANT" : product.financialType != null ? "PRODUCT" : "UNKNOWN";

  const includesVase = variant.includesVase ?? product.defaultIncludesVase ?? null;
  const includesVaseSource: EffectiveSource =
    variant.includesVase != null ? "VARIANT" : product.defaultIncludesVase != null ? "PRODUCT" : "UNKNOWN";

  const byVariant = (r: VaseCostRow) => r.productVariantId === variant.id;
  const byProduct = (r: VaseCostRow) => r.productId === product.id;

  let row: VaseCostRow | null = null;
  let costType: VaseCostType | null = null;

  if (financialType === "VASE") {
    // Сама позиция — ваза. Признак includesVase здесь не участвует вообще.
    costType = "STANDALONE_VASE";
    row = pick(costs, costType, at, byVariant) ?? pick(costs, costType, at, byProduct);
  } else if (financialType === "FLOWER_PRODUCT" && includesVase === true) {
    // Букет с вазой: только INCLUDED_VASE, сначала вариант, потом товар.
    // STANDALONE_VASE к букету не применяется никогда.
    costType = "INCLUDED_VASE";
    row = pick(costs, costType, at, byVariant) ?? pick(costs, costType, at, byProduct);
  }
  // includesVase === false — подтверждённое отсутствие вазы: стоимость не применяется,
  // даже если запись INCLUDED_VASE существует. Саму запись при этом не удаляем.

  const reviewReasons: CatalogReviewReason[] = [];
  if (financialType === null) reviewReasons.push("ITEM_UNCLASSIFIED");
  const costUnknown =
    (financialType === "VASE" && row === null) ||
    (financialType === "FLOWER_PRODUCT" && includesVase === true && row === null) ||
    // Тип известен, но есть ли ваза — нет. Это именно «не знаем», а не «вазы нет».
    (financialType === "FLOWER_PRODUCT" && includesVase === null);
  if (costUnknown) reviewReasons.push("VASE_COST_MISSING");

  return {
    financialType,
    financialTypeSource,
    includesVase,
    includesVaseSource,
    vaseCostCents: row ? row.purchaseCostCents : null,
    vaseCostType: row ? row.costType : null,
    vaseCostSource: row ? (row.productVariantId ? "VARIANT" : "PRODUCT") : "UNKNOWN",
    vaseCostRecordId: row?.id ?? null,
    reviewReasons,
  };
}
