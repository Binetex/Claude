/**
 * Чего не хватает заказу для расчёта — человеческими словами.
 *
 * Обычный модуль (не "use client"): подписи читают и серверные страницы разбора дня и заказа.
 * Держим в одном месте, потому что список показывается в двух — и разойтись он не должен:
 * «нет комиссии» в одном экране и «ACQUIRING_FEE» в другом читаются как разные проблемы.
 */
export const MISSING_INPUT_LABELS: Record<string, string> = {
  DELIVERY_ACTUAL_COST: "фактическая доставка",
  ACQUIRING_FEE: "комиссия эквайринга",
  VASE_GIFT_COST: "закупка вазы или подарка",
  CONSUMABLES_RATE: "ставка расходников",
};

export function missingLabel(code: string): string {
  return MISSING_INPUT_LABELS[code] ?? code;
}

/**
 * Сводка причин «заказ нужно дополнить» одной строкой — общая для всех экранов,
 * которые показывают этот список: обзор флористов и разбор дня обязаны читаться одинаково.
 */
export function incompleteSummary(o: { missing: string[]; noFloristPrice: boolean }): string {
  return [
    o.noFloristPrice ? "не задана цена флориста" : null,
    o.missing.length > 0 ? `не заполнено: ${o.missing.map(missingLabel).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}
