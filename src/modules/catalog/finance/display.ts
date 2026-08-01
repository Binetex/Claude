/** Подписи финансовой классификации каталога. Чистый модуль: годится и на сервере, и в клиенте. */
import type { FinancialItemType } from "@/generated/prisma/enums";

export const FINANCIAL_TYPE_LABELS: Record<FinancialItemType, string> = {
  FLOWER_PRODUCT: "Обычный букет",
  VASE: "Ваза",
  TIP: "Чаевые",
  DELIVERY: "Доставка",
  TAX: "Налог",
  SERVICE_FEE: "Сервисный сбор",
  DISCOUNT: "Скидка",
  CARD: "Открытка",
  GIFT: "Подарок",
  OTHER: "Другое",
};

/**
 * Что владелец выбирает в КАТАЛОГЕ. Обычный букет — умолчание, поэтому в списке его нет:
 * он и есть пункт «ничего не выбирать».
 *
 * Остальные значения enum (TIP, TAX, DELIVERY, SERVICE_FEE, DISCOUNT, CARD) в каталоге не
 * встречаются: это строки заказа, которые приходят от Shopify и Woo и классифицируются
 * финансовым модулем, а не товары. Поэтому enum не трогаем, а список сокращаем.
 */
export const CATALOG_TYPE_ORDER: FinancialItemType[] = ["VASE", "GIFT", "OTHER"];

/** Подпись типа. NULL = умолчание, а не «не настроено»: обычный букет получается сам. */
export function financialTypeLabel(t: FinancialItemType | null | undefined): string {
  return t ? FINANCIAL_TYPE_LABELS[t] : DEFAULT_TYPE_LABEL;
}

/** Как называется умолчание в интерфейсе — одинаково во всех списках. */
export const DEFAULT_TYPE_LABEL = "Обычный букет (по умолчанию)";

/** Человеческая подпись трёх состояний признака вазы. */
export function includesVaseLabel(v: boolean | null | undefined): string {
  if (v === true) return "Содержит вазу";
  return "Без вазы";
}

export function sourceLabel(source: "VARIANT" | "PRODUCT" | "DEFAULT"): string {
  if (source === "VARIANT") return "задано у варианта";
  if (source === "PRODUCT") return "унаследовано от товара";
  return "по умолчанию";
}

/** Заголовок блока закупочной стоимости — зависит от типа позиции. */
export function purchaseCostTitle(t: FinancialItemType): string {
  if (t === "VASE") return "Закупочная стоимость вазы";
  if (t === "GIFT") return "Закупочная стоимость подарка";
  return "Закупочная стоимость позиции";
}
