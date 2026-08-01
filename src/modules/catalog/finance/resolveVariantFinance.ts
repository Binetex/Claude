/**
 * Резолв финансовых свойств позиции каталога: тип, признак вазы, связанная ваза и её
 * закупочная себестоимость.
 *
 * Чистая функция без Prisma и без «сейчас»: дата передаётся снаружи — это дата доставки
 * заказа. Поэтому изменение прайса сегодня не меняет расчёт вчерашнего заказа.
 *
 * Стоимость вазы у букета НЕ хранится. Она берётся у связанного варианта-вазы
 * (VasePurchaseCost, тип STANDALONE_VASE) — один источник на всю сеть букетов с этой вазой.
 * Цена клиента (listPrice) себестоимостью не становится ни в одной ветке: сюда она не приходит.
 *
 * Три состояния каждого свойства не схлопываются:
 *   inherited — своего значения нет, действует значение товара;
 *   override  — задано на варианте (в том числе false);
 *   unknown   — не задано нигде.
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

/** Сведения о варианте-вазе, на который ссылается букет. Собирает вызывающий. */
export type LinkedVaseInfo = {
  id: string;
  productId: string;
  /** Эффективный тип вазы: собственный тип варианта, иначе тип её товара. */
  effectiveType: FinancialItemType | null;
  archived: boolean;
  label: string;
};

export type VariantFinanceInput = {
  variant: {
    id: string;
    financialType: FinancialItemType | null;
    includesVase: boolean | null;
    includedVaseVariantId?: string | null;
  };
  product: {
    id: string;
    financialType: FinancialItemType | null;
    defaultIncludesVase: boolean | null;
    defaultIncludedVaseVariantId?: string | null;
  };
  /** Строки стоимости: собственные (для позиции-вазы) и связанной вазы. */
  costs: VaseCostRow[];
  /** Справочник связанных ваз по id варианта. */
  vases?: Record<string, LinkedVaseInfo>;
  at: Date;
};

export type CatalogReviewReason =
  | "ITEM_UNCLASSIFIED"
  | "VASE_LINK_MISSING"
  | "VASE_COST_MISSING"
  | "VASE_ARCHIVED";

export type VariantFinance = {
  financialType: FinancialItemType | null;
  financialTypeSource: EffectiveSource;
  includesVase: boolean | null;
  includesVaseSource: EffectiveSource;
  /** Связанная ваза, применённая в расчёте (после всех правил). */
  vase: LinkedVaseInfo | null;
  vaseSource: EffectiveSource;
  vaseCostCents: number | null;
  vaseCostRecordId: string | null;
  reviewReasons: CatalogReviewReason[];
};

/** Активна ли строка на дату: полуинтервал [from, to). */
function isActiveAt(row: VaseCostRow, at: Date): boolean {
  if (row.effectiveFrom.getTime() > at.getTime()) return false;
  return row.effectiveTo === null || row.effectiveTo.getTime() > at.getTime();
}

function pick(costs: VaseCostRow[], at: Date, match: (row: VaseCostRow) => boolean): VaseCostRow | null {
  // Тип всегда STANDALONE_VASE: себестоимость лежит у самой вазы. INCLUDED_VASE — legacy.
  return costs.find((r) => r.costType === "STANDALONE_VASE" && match(r) && isActiveAt(r, at)) ?? null;
}

export function resolveVariantFinance(input: VariantFinanceInput): VariantFinance {
  const { variant, product, costs, at } = input;
  const vases = input.vases ?? {};

  const financialType = variant.financialType ?? product.financialType ?? null;
  const financialTypeSource: EffectiveSource =
    variant.financialType != null ? "VARIANT" : product.financialType != null ? "PRODUCT" : "UNKNOWN";

  const includesVase = variant.includesVase ?? product.defaultIncludesVase ?? null;
  const includesVaseSource: EffectiveSource =
    variant.includesVase != null ? "VARIANT" : product.defaultIncludesVase != null ? "PRODUCT" : "UNKNOWN";

  const reviewReasons: CatalogReviewReason[] = [];
  if (financialType === null) reviewReasons.push("ITEM_UNCLASSIFIED");

  let vase: LinkedVaseInfo | null = null;
  let vaseSource: EffectiveSource = "UNKNOWN";
  let row: VaseCostRow | null = null;

  if (financialType === "VASE") {
    // Позиция и есть ваза: берём её собственную себестоимость. includesVase не участвует.
    row = pick(costs, at, (r) => r.productVariantId === variant.id) ?? pick(costs, at, (r) => r.productId === product.id);
    if (row === null) reviewReasons.push("VASE_COST_MISSING");
  } else if (financialType === "FLOWER_PRODUCT" && includesVase === true) {
    // Букет с вазой: ссылка варианта приоритетнее товарного дефолта.
    const linkId = variant.includedVaseVariantId ?? product.defaultIncludedVaseVariantId ?? null;
    vaseSource = variant.includedVaseVariantId ? "VARIANT" : product.defaultIncludedVaseVariantId ? "PRODUCT" : "UNKNOWN";
    const linked = linkId ? (vases[linkId] ?? null) : null;

    if (!linked || linked.effectiveType !== "VASE") {
      // Ссылки нет, ваза не найдена или связана не с вазой — считать нечего.
      reviewReasons.push("VASE_LINK_MISSING");
      vaseSource = "UNKNOWN";
    } else {
      vase = linked;
      if (linked.archived) reviewReasons.push("VASE_ARCHIVED");
      row =
        pick(costs, at, (r) => r.productVariantId === linked.id) ??
        pick(costs, at, (r) => r.productId === linked.productId);
      if (row === null) reviewReasons.push("VASE_COST_MISSING");
    }
  } else if (financialType === "FLOWER_PRODUCT" && includesVase === null) {
    // Тип известен, но есть ли ваза — нет. Это «не знаем», а не «вазы нет».
    reviewReasons.push("VASE_LINK_MISSING");
  }
  // includesVase === false — подтверждённое отсутствие вазы: ссылка не применяется даже если
  // она есть у варианта или задана дефолтом товара. Историческую запись не удаляем.

  return {
    financialType,
    financialTypeSource,
    includesVase,
    includesVaseSource,
    vase,
    vaseSource,
    vaseCostCents: row ? row.purchaseCostCents : null,
    vaseCostRecordId: row?.id ?? null,
    reviewReasons,
  };
}
