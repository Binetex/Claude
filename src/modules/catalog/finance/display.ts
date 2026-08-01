/** Подписи финансовой классификации каталога. Чистый модуль: годится и на сервере, и в клиенте. */
import type { FinancialItemType } from "@/generated/prisma/enums";

export const FINANCIAL_TYPE_LABELS: Record<FinancialItemType, string> = {
  FLOWER_PRODUCT: "Цветочный товар",
  VASE: "Ваза",
  TIP: "Чаевые",
  DELIVERY: "Доставка",
  TAX: "Налог",
  SERVICE_FEE: "Сервисный сбор",
  DISCOUNT: "Скидка",
  CARD: "Открытка",
  GIFT: "Подарок",
  OTHER: "Прочее",
};

/** Порядок в выпадающих списках: сначала то, что реально встречается в каталоге. */
export const FINANCIAL_TYPE_ORDER: FinancialItemType[] = [
  "FLOWER_PRODUCT",
  "VASE",
  "GIFT",
  "CARD",
  "SERVICE_FEE",
  "DELIVERY",
  "TIP",
  "TAX",
  "DISCOUNT",
  "OTHER",
];

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
