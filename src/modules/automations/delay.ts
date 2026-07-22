/**
 * Вычисление времени отправки по задержке правила. IMMEDIATE или неположительное amount → сейчас.
 * MONTH считается календарно (setMonth), остальные единицы — фиксированными интервалами.
 */
export type SmsDelayUnit = "IMMEDIATE" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";

const FIXED_MS: Partial<Record<SmsDelayUnit, number>> = {
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  WEEK: 604_800_000,
};

export function computeScheduledAt(from: Date, amount: number, unit: SmsDelayUnit): Date {
  if (unit === "IMMEDIATE" || !Number.isFinite(amount) || amount <= 0) {
    return new Date(from.getTime());
  }
  const fixed = FIXED_MS[unit];
  if (fixed) return new Date(from.getTime() + amount * fixed);
  if (unit === "MONTH") {
    const d = new Date(from.getTime());
    d.setMonth(d.getMonth() + amount);
    return d;
  }
  return new Date(from.getTime());
}
