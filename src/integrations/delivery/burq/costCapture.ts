/**
 * Чистая логика захвата фактической стоимости доставки (Path A, post-dispatch).
 * Суммы Burq — в ЦЕНТАХ; наружу отдаём доллары (число для Decimal).
 *
 * Приоритет суммы (подтверждён контрактом): total_amount_due (полная фактическая сумма к
 * списанию, вкл. комиссии) → иначе fee. Если суммы нет — старое значение НЕ обнуляем.
 *
 * **Провайдер роли не играет.** Раньше сумма принималась ТОЛЬКО у Uber — осторожность тех
 * времён, когда другого провайдера в проде не видели. 23.09.2026 нашлись два заказа
 * (OHARA-1070, PAR-41355), которые Burq отдал Grubhub: суммы в его ответе лежали ровно те же
 * (`totalAmountDueCents`, `feeCents`), а мы их выбрасывали. В карточке висело «Доставка (факт):
 * не подтверждена», день у флориста не считался, и починить это можно было только руками.
 * Платим мы за любого курьера, поэтому и записываем сумму любого.
 */

/** Выбор суммы в центах: total_amount_due приоритетнее fee. null — валидной суммы нет. */
export function pickCostCents(totalAmountDueCents: number | null | undefined, feeCents: number | null | undefined): number | null {
  for (const v of [totalAmountDueCents, feeCents]) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** Центы → доллары (число для Decimal 10,2). */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

export type IncomingCost = {
  provider: string | null;
  providerId: string | null;
  totalAmountDueCents: number | null;
  feeCents: number | null;
  currency: string | null;
  quoteId: string | null;
  occurredAt: Date | null;
};

export type ExistingCostState = {
  finalCostUpdatedAt: Date | null;
};

export type CostDecision =
  | { apply: true; cents: number; dollars: number }
  | { apply: false; reason: "no_valid_amount" | "stale" };

/**
 * Решение: применять ли обновление стоимости. Валидная сумма + не старее уже сохранённого.
 * Отсутствие суммы → НЕ применяем (старое значение сохраняется вызывающим).
 */
export function decideCostUpdate(existing: ExistingCostState, incoming: IncomingCost): CostDecision {
  const cents = pickCostCents(incoming.totalAmountDueCents, incoming.feeCents);
  if (cents == null) return { apply: false, reason: "no_valid_amount" };
  if (existing.finalCostUpdatedAt && incoming.occurredAt && incoming.occurredAt < existing.finalCostUpdatedAt) {
    return { apply: false, reason: "stale" };
  }
  return { apply: true, cents, dollars: centsToDollars(cents) };
}
