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
 * Тип по умолчанию — FLOWER_PRODUCT. Ничего не задавать НЕ НАДО: обычный букет получается сам,
 * владелец размечает только исключения (вазы, подарки, открытки, сервисные позиции). Поэтому
 * состояния «без классификации» не существует, и NULL в базе означает «действует умолчание»,
 * а не «требуется настройка» — по этому же признаку видно, где владелец выбрал тип осознанно.
 *
 * Источник значения различается всегда: задано у варианта · унаследовано от товара · умолчание.
 */
import type { FinancialItemType, VaseCostType } from "@/generated/prisma/enums";

export type EffectiveSource = "VARIANT" | "PRODUCT" | "DEFAULT";

/** Тип позиции, когда владелец ничего не выбирал. Обычный букет — самый частый случай. */
export const DEFAULT_FINANCIAL_TYPE = "FLOWER_PRODUCT" as const;

/**
 * Эффективный финансовый тип. ЕДИНСТВЕННОЕ место, где решается, чем является позиция:
 * вариант → товар → умолчание. Ни один вызывающий не должен трактовать NULL по-своему.
 */
export function effectiveFinancialType(
  variantType: FinancialItemType | null | undefined,
  productType: FinancialItemType | null | undefined
): FinancialItemType {
  return variantType ?? productType ?? DEFAULT_FINANCIAL_TYPE;
}

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
  /** Букет заявлен с вазой, но ваза не выбрана. */
  | "VASE_LINK_MISSING"
  /** У связанной вазы нет закупочной стоимости на дату. */
  | "VASE_COST_MISSING"
  /** У самой позиции (ваза, подарок, прочее) нет закупочной стоимости на дату. */
  | "PURCHASE_COST_MISSING"
  | "VASE_ARCHIVED";

export type VariantFinance = {
  /** Всегда определён: пустого типа больше не существует. */
  financialType: FinancialItemType;
  financialTypeSource: EffectiveSource;
  /** Всегда определён: по умолчанию вазы нет. */
  includesVase: boolean;
  includesVaseSource: EffectiveSource;
  /** Связанная ваза, применённая в расчёте (после всех правил). */
  vase: LinkedVaseInfo | null;
  vaseSource: EffectiveSource;
  /**
   * Закупочная себестоимость, применимая к позиции на дату:
   * для вазы/подарка/прочего — её собственная, для букета с вазой — стоимость связанной вазы.
   * Обычный букет своей закупки не имеет: его себестоимость — это цена флориста.
   */
  purchaseCostCents: number | null;
  purchaseCostRecordId: string | null;
  reviewReasons: CatalogReviewReason[];
};

/** Активна ли строка на дату: полуинтервал [from, to). */
function isActiveAt(row: VaseCostRow, at: Date): boolean {
  if (row.effectiveFrom.getTime() > at.getTime()) return false;
  return row.effectiveTo === null || row.effectiveTo.getTime() > at.getTime();
}

function pick(costs: VaseCostRow[], at: Date, match: (row: VaseCostRow) => boolean): VaseCostRow | null {
  // STANDALONE_VASE здесь означает «закупочная себестоимость самой позиции»: она нужна не
  // только вазам, но и подаркам и прочим непветочным позициям. Имя значения осталось от
  // первой версии; заводить второе с тем же смыслом хуже, чем пояснить это здесь.
  // INCLUDED_VASE не используется: стоимость вазы внутри букета берётся у связанной вазы.
  return costs.find((r) => r.costType === "STANDALONE_VASE" && match(r) && isActiveAt(r, at)) ?? null;
}

export function resolveVariantFinance(input: VariantFinanceInput): VariantFinance {
  const { variant, product, costs, at } = input;
  const vases = input.vases ?? {};

  const financialType = effectiveFinancialType(variant.financialType, product.financialType);
  const financialTypeSource: EffectiveSource =
    variant.financialType != null ? "VARIANT" : product.financialType != null ? "PRODUCT" : "DEFAULT";

  // Букет без вазы — тоже умолчание: вазу отмечают только там, где она действительно есть.
  const includesVase = variant.includesVase ?? product.defaultIncludesVase ?? false;
  const includesVaseSource: EffectiveSource =
    variant.includesVase != null ? "VARIANT" : product.defaultIncludesVase != null ? "PRODUCT" : "DEFAULT";

  const reviewReasons: CatalogReviewReason[] = [];

  let vase: LinkedVaseInfo | null = null;
  let vaseSource: EffectiveSource = "DEFAULT";
  let row: VaseCostRow | null = null;

  if (financialType !== "FLOWER_PRODUCT") {
    // Ваза, подарок, прочее — у позиции есть собственная закупка. Признак вазы не участвует.
    row = pick(costs, at, (r) => r.productVariantId === variant.id) ?? pick(costs, at, (r) => r.productId === product.id);
    if (row === null) reviewReasons.push("PURCHASE_COST_MISSING");
  } else if (includesVase === true) {
    // Букет с вазой: ссылка варианта приоритетнее товарного дефолта.
    const linkId = variant.includedVaseVariantId ?? product.defaultIncludedVaseVariantId ?? null;
    vaseSource = variant.includedVaseVariantId ? "VARIANT" : product.defaultIncludedVaseVariantId ? "PRODUCT" : "DEFAULT";
    const linked = linkId ? (vases[linkId] ?? null) : null;

    if (!linked || linked.effectiveType !== "VASE") {
      // Ссылки нет, ваза не найдена или связана не с вазой — считать нечего.
      reviewReasons.push("VASE_LINK_MISSING");
      vaseSource = "DEFAULT";
    } else {
      vase = linked;
      if (linked.archived) reviewReasons.push("VASE_ARCHIVED");
      row =
        pick(costs, at, (r) => r.productVariantId === linked.id) ??
        pick(costs, at, (r) => r.productId === linked.productId);
      if (row === null) reviewReasons.push("VASE_COST_MISSING");
    }
  }
  // includesVase === false (заданное или по умолчанию) — вазы нет: ссылка не применяется, даже
  // если она есть у варианта или задана дефолтом товара. Историческую запись не удаляем.

  return {
    financialType,
    financialTypeSource,
    includesVase,
    includesVaseSource,
    vase,
    vaseSource,
    purchaseCostCents: row ? row.purchaseCostCents : null,
    purchaseCostRecordId: row?.id ?? null,
    reviewReasons,
  };
}
