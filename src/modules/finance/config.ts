import "server-only";
/**
 * Конфигурация финансового модуля. Читается динамически из env, как и остальные
 * runtime-гейты проекта (см. isBurqRuntimeEnabled).
 *
 * Два выключателя, и оба нужны:
 *
 *  1. FINANCE_ACCRUAL_ENABLED — главный. По умолчанию ВЫКЛЮЧЕН, поэтому деплой сам по себе
 *     не начисляет ничего: раздел «Финансы» появляется пустым, и владелец включает
 *     начисление осознанно.
 *
 *  2. FINANCE_ACCRUAL_START_DATE — дата, раньше которой заказы не начисляются. Без неё
 *     первый же проход по доставленным заказам начислил бы всю историю разом, а массовый
 *     backfill начислений в этот этап не входит. Заодно это отсекает 89 доставленных
 *     заказов, подтянутых историческим backfill'ом Shopify (у них нет флориста вовсе).
 *
 * Отсутствие даты трактуется как «начисление не настроено» — гейт закрыт даже при
 * включённом флаге. Молчаливого умолчания «с начала времён» здесь быть не должно.
 */

export function isFinanceAccrualEnabled(): boolean {
  return process.env.FINANCE_ACCRUAL_ENABLED === "true";
}

/** Дата старта начислений (UTC-полночь) или null, если не задана/задана мусором. */
export function financeAccrualStartDate(): Date | null {
  const raw = process.env.FINANCE_ACCRUAL_START_DATE?.trim();
  if (!raw) return null;
  // Только YYYY-MM-DD: сравниваем с Order.deliveryDate, которая тоже UTC-полночь
  // локального дня доставки. Момент времени здесь был бы источником сдвига на сутки.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type AccrualGate = { enabled: true; startDate: Date } | { enabled: false; reason: string };

/** Единая точка ответа «можно ли сейчас начислять». Используют и воркер, и UI. */
export function accrualGate(): AccrualGate {
  if (!isFinanceAccrualEnabled()) {
    return { enabled: false, reason: "FINANCE_ACCRUAL_ENABLED=false" };
  }
  const startDate = financeAccrualStartDate();
  if (!startDate) {
    return { enabled: false, reason: "FINANCE_ACCRUAL_START_DATE не задана (формат YYYY-MM-DD)" };
  }
  return { enabled: true, startDate };
}
