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

export function financialTypeLabel(t: FinancialItemType | null | undefined): string {
  return t ? FINANCIAL_TYPE_LABELS[t] : "Без классификации";
}

/** Человеческая подпись трёх состояний признака вазы. */
export function includesVaseLabel(v: boolean | null | undefined): string {
  if (v === true) return "Содержит вазу";
  if (v === false) return "Без вазы";
  return "Не настроено";
}

export function sourceLabel(source: "VARIANT" | "PRODUCT" | "UNKNOWN"): string {
  if (source === "VARIANT") return "задано у варианта";
  if (source === "PRODUCT") return "унаследовано от товара";
  return "не задано";
}
