/**
 * Условия автоматизации. `conditionsJson` — расширяемый объект (в БД Json). В MVP поддержаны
 * базовые флаги; неизвестные ключи игнорируются (forward-compatible). Оценка чистая и
 * тестируемая: на вход — срез заказа, на выход — пропускать или причина SKIP.
 *
 * Расширение: добавить поле в SmsConditions + ветку в evaluateConditions (минимальная/макс.
 * сумма, платформа, новый/повторный клиент и т.д.) — без изменения схемы БД.
 */

export type SmsConditions = {
  /** Исключать отменённые/возвращённые заказы (по умолчанию ВКЛ, даже если не задано). */
  excludeCancelledRefunded?: boolean;
  /** Требовать оплату (PAID или BNPL-approved). */
  requirePaid?: boolean;
  /** Доставка сегодня (в таймзоне магазина). */
  deliveryToday?: boolean;
  /** Указан номер квартиры/юнита. */
  apartmentPresent?: boolean;
};

export type ConditionContext = {
  orderStatus: string; // OrderStatus
  paymentStatus: string; // PaymentStatus
  deliveryDate: Date | null;
  apartment: string | null;
  timezone: string | null;
  now?: Date;
};

export type ConditionResult = { ok: true } | { ok: false; skipReason: string };

const PAID_STATUSES = new Set(["PAID", "PAY_LATER_APPROVED"]);
const CANCELLED_REFUNDED = new Set(["CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"]);

/** Один ли это локальный день (в указанной таймзоне) для двух дат. */
export function isSameLocalDay(a: Date, b: Date, timezone: string | null): boolean {
  const fmt = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: timezone || "UTC",
      }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(d);
    }
  };
  return fmt(a) === fmt(b);
}

export function evaluateConditions(conditions: SmsConditions | null | undefined, ctx: ConditionContext): ConditionResult {
  const c = conditions ?? {};
  const now = ctx.now ?? new Date();

  // Отменённые/возвращённые исключаются по умолчанию (если явно не выключено).
  if (c.excludeCancelledRefunded !== false) {
    if (CANCELLED_REFUNDED.has(ctx.orderStatus) || CANCELLED_REFUNDED.has(ctx.paymentStatus)) {
      return { ok: false, skipReason: "order_cancelled_or_refunded" };
    }
  }

  if (c.requirePaid && !PAID_STATUSES.has(ctx.paymentStatus)) {
    return { ok: false, skipReason: "not_paid" };
  }

  if (c.deliveryToday) {
    if (!ctx.deliveryDate || !isSameLocalDay(ctx.deliveryDate, now, ctx.timezone)) {
      return { ok: false, skipReason: "not_delivery_today" };
    }
  }

  if (c.apartmentPresent && !(ctx.apartment && ctx.apartment.trim().length > 0)) {
    return { ok: false, skipReason: "no_apartment" };
  }

  return { ok: true };
}
