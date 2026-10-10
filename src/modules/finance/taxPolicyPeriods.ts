/**
 * Налоговая политика владельца по дням (владелец 10.10.2026). Чистые функции — без БД.
 *
 * Запись действует с `effectiveFrom` до следующей записи той же области. На день берётся своя
 * запись магазина, начавшаяся не позже этого дня, иначе общая; нет ни той ни другой — налог
 * считается расходом полностью (100%): занизить расход значило бы показать прибыль, которой нет.
 * База флориста от этого не зависит — в ней налог вычитается всегда на 100%.
 */
export type TaxPolicyRow = { siteId: string | null; actualShareBp: number; effectiveFrom: Date };

/** «Всегда» — дата записей, заведённых до появления даты начала. */
export const TAX_POLICY_ALWAYS = new Date("2000-01-01T00:00:00.000Z");

const FULL_SHARE_BP = 10000;

function latestOn<T extends TaxPolicyRow>(rows: T[], scope: string | null, day: Date): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.siteId !== scope || r.effectiveFrom.getTime() > day.getTime()) continue;
    if (!best || r.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = r;
  }
  return best;
}

/** Действующая на день запись: своя магазина, иначе общая. */
export function taxPolicyOn<T extends TaxPolicyRow>(rows: T[], siteId: string, day: Date): T | null {
  return latestOn(rows, siteId, day) ?? latestOn(rows, null, day);
}

/** Доля налога (б.п.), которая на этот день — реальный расход владельца. */
export function taxShareOn(rows: TaxPolicyRow[], siteId: string, day: Date): number {
  return taxPolicyOn(rows, siteId, day)?.actualShareBp ?? FULL_SHARE_BP;
}

/** До какого дня включительно действует запись: день перед следующей записью той же области. */
export function taxPolicyUntil(rows: TaxPolicyRow[], row: TaxPolicyRow): Date | null {
  let next: Date | null = null;
  for (const r of rows) {
    if (r.siteId !== row.siteId || r.effectiveFrom.getTime() <= row.effectiveFrom.getTime()) continue;
    if (!next || r.effectiveFrom.getTime() < next.getTime()) next = r.effectiveFrom;
  }
  return next ? new Date(next.getTime() - 86_400_000) : null;
}

export type TaxPolicyTotals = { orders: number; collectedCents: number; deductedCents: number };

/**
 * Сколько налога клиенты заплатили и сколько из него вычтено из дохода владельца — по каждой
 * записи политики: заказ относится к той записи, что действовала на его день доставки. Вычет
 * округляется по заказу, как в расчёте дня (`orderInput.ts`), поэтому суммы сходятся с «Финансами».
 */
export function taxTotalsByPolicy<T extends TaxPolicyRow & { id: string }>(
  rows: T[],
  orders: { siteId: string; deliveryDate: Date; taxCents: number }[]
): Map<string, TaxPolicyTotals> {
  const out = new Map<string, TaxPolicyTotals>();
  for (const o of orders) {
    const row = taxPolicyOn(rows, o.siteId, o.deliveryDate);
    if (!row) continue;
    const t = out.get(row.id) ?? { orders: 0, collectedCents: 0, deductedCents: 0 };
    t.orders += 1;
    t.collectedCents += o.taxCents;
    t.deductedCents += Math.round((o.taxCents * row.actualShareBp) / 10000);
    out.set(row.id, t);
  }
  return out;
}

/** Что станет с налоговым расходом владельца, если заменить ставки `before` на `after`. */
export type OwnerTaxChange = {
  /** Заказы, у которых меняется вычет. */
  orders: number;
  collectedCents: number;
  beforeCents: number;
  afterCents: number;
  /** after − before: плюс — расход растёт и доход в «Финансах» становится меньше. */
  deltaCents: number;
  /** Первый и последний день доставки задетых заказов — YYYY-MM-DD; null, если не задет никто. */
  fromDay: string | null;
  toDay: string | null;
};

/**
 * Предварительный расчёт правки ставки (владелец 10.10.2026: «чтобы я видел, так как я постфактум
 * иногда делаю»). Тот же разбор по дням и то же округление по заказу, что в «Финансах».
 */
export function ownerTaxChange(
  before: TaxPolicyRow[],
  after: TaxPolicyRow[],
  orders: { siteId: string; deliveryDate: Date; taxCents: number }[]
): OwnerTaxChange {
  const out: OwnerTaxChange = { orders: 0, collectedCents: 0, beforeCents: 0, afterCents: 0, deltaCents: 0, fromDay: null, toDay: null };
  for (const o of orders) {
    const b = Math.round((o.taxCents * taxShareOn(before, o.siteId, o.deliveryDate)) / 10000);
    const a = Math.round((o.taxCents * taxShareOn(after, o.siteId, o.deliveryDate)) / 10000);
    if (a === b) continue;
    const day = o.deliveryDate.toISOString().slice(0, 10);
    out.orders += 1;
    out.collectedCents += o.taxCents;
    out.beforeCents += b;
    out.afterCents += a;
    if (!out.fromDay || day < out.fromDay) out.fromDay = day;
    if (!out.toDay || day > out.toDay) out.toDay = day;
  }
  out.deltaCents = out.afterCents - out.beforeCents;
  return out;
}
