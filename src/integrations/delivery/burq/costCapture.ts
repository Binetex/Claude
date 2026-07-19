/**
 * Чистая логика захвата фактической стоимости доставки Uber (Path A, post-dispatch).
 * Суммы Burq — в ЦЕНТАХ; наружу отдаём доллары (число для Decimal).
 *
 * Приоритет суммы (подтверждён контрактом): total_amount_due (полная фактическая сумма к
 * списанию, вкл. комиссии) → иначе fee. Если суммы нет — старое значение НЕ обнуляем.
 * Только Uber: пока по нормализованному имени провайдера; при появлении реального provider_id —
 * сохраняем его и переходим на сравнение по id.
 */

/**
 * Подтверждённый СТАБИЛЬНЫЙ Uber provider id. Из реального dispatched-заказа PAR-1308:
 * webhook `provider = { id: "dsp_19g67ldj7ek3j", name: "Uber" }` → стабильный id = `dsp_19g67ldj7ek3j`
 * (префикс `dsp_` = dispatch service provider). ВНИМАНИЕ: top-level `provider_id` (`del_...`) —
 * ПОКОШТУЧНЫЙ id доставки, НЕ провайдер; его сюда НЕ писать. OR-логика с именем сохраняет fallback.
 */
export const CONFIRMED_UBER_PROVIDER_ID: string | null = "dsp_19g67ldj7ek3j";

/** Нормализация имени провайдера: строка → lowercase без краёв; не-строку → "" (защита). */
function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/**
 * Провайдер — Uber? По подтверждённому стабильному id (если задан) ИЛИ по имени "uber"
 * (регистронезависимо; реальный provider="Uber"). OR-логика: id не ломает fallback по имени.
 */
export function isUberProvider(provider: string | null | undefined, providerId: string | null | undefined): boolean {
  if (CONFIRMED_UBER_PROVIDER_ID && providerId === CONFIRMED_UBER_PROVIDER_ID) return true;
  return norm(provider) === "uber";
}

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
  | { apply: false; reason: "not_uber" | "no_valid_amount" | "stale" };

/**
 * Решение: применять ли обновление стоимости. Uber + валидная сумма + не старее уже сохранённого.
 * Отсутствие суммы → НЕ применяем (старое значение сохраняется вызывающим).
 */
export function decideCostUpdate(existing: ExistingCostState, incoming: IncomingCost): CostDecision {
  if (!isUberProvider(incoming.provider, incoming.providerId)) return { apply: false, reason: "not_uber" };
  const cents = pickCostCents(incoming.totalAmountDueCents, incoming.feeCents);
  if (cents == null) return { apply: false, reason: "no_valid_amount" };
  if (existing.finalCostUpdatedAt && incoming.occurredAt && incoming.occurredAt < existing.finalCostUpdatedAt) {
    return { apply: false, reason: "stale" };
  }
  return { apply: true, cents, dollars: centsToDollars(cents) };
}
