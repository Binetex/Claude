/**
 * Чистая логика привязки события QUO к заказу по НОРМАЛИЗОВАННОМУ (E.164) телефону собеседника.
 * Без БД — тестируется напрямую. Вызывающий код заранее выбирает заказы-кандидаты, где этот
 * телефон встречается как senderPhone (покупатель) или recipientPhone (получатель).
 *
 * Правила (см. ТЗ §4): привязка НА УРОВНЕ СОБЫТИЯ (телефон не «закрепляется» за заказом навсегда).
 *  1) отсекаем отменённые/возвращённые заказы, если есть другие;
 *  2) приоритет активным заказам (дата доставки не сильно в прошлом относительно времени события);
 *  3) среди них выбираем заказ с датой доставки, ближайшей ко времени коммуникации;
 *  4) при неоднозначности (два одинаково подходящих) — НЕ привязываем автоматически (unlinked).
 */
export type CommOrderCandidate = {
  orderId: string;
  senderPhoneE164: string | null; // покупатель / billing
  recipientPhoneE164: string | null; // получатель доставки
  deliveryDate: Date;
  orderStatus: string;
};

export type MatchResult =
  | { matched: true; orderId: string; partyRole: "CUSTOMER" | "RECIPIENT" }
  | { matched: false; reason: "no_candidate" | "ambiguous" };

const NON_ACTIVE_STATUSES = new Set(["CANCELLED", "REFUNDED"]);
/** Насколько «назад» дата доставки ещё считается недавно завершённым активным заказом. */
const RECENT_WINDOW_MS = 3 * 24 * 3600 * 1000;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Роль телефона в конкретном заказе: покупатель приоритетнее, если совпал и там, и там. */
function roleFor(c: CommOrderCandidate, phoneE164: string): "CUSTOMER" | "RECIPIENT" | null {
  if (c.senderPhoneE164 === phoneE164) return "CUSTOMER";
  if (c.recipientPhoneE164 === phoneE164) return "RECIPIENT";
  return null;
}

export function matchCommunicationToOrder(
  externalPhoneE164: string,
  occurredAt: Date,
  candidates: CommOrderCandidate[]
): MatchResult {
  // Только заказы, где телефон реально совпал с одной из ролей.
  const withRole = candidates
    .map((c) => ({ c, role: roleFor(c, externalPhoneE164) }))
    .filter((x): x is { c: CommOrderCandidate; role: "CUSTOMER" | "RECIPIENT" } => x.role !== null);

  if (withRole.length === 0) return { matched: false, reason: "no_candidate" };
  if (withRole.length === 1) return { matched: true, orderId: withRole[0].c.orderId, partyRole: withRole[0].role };

  // 1) Предпочитаем не-терминальные (не отменён/возврат), если такие есть.
  const nonCancelled = withRole.filter((x) => !NON_ACTIVE_STATUSES.has(x.c.orderStatus));
  const pool = nonCancelled.length ? nonCancelled : withRole;

  // 2) Предпочитаем активные: дата доставки сегодня/завтра/в будущем/недавно завершённые.
  const activeFrom = startOfUtcDay(occurredAt) - RECENT_WINDOW_MS;
  const active = pool.filter((x) => x.c.deliveryDate.getTime() >= activeFrom);
  const chosen = active.length ? active : pool;

  // 3) Ближайшая дата доставки ко времени коммуникации.
  const scored = chosen
    .map((x) => ({ ...x, dist: Math.abs(x.c.deliveryDate.getTime() - occurredAt.getTime()) }))
    .sort((a, b) => a.dist - b.dist);

  // 4) Неоднозначность: два кандидата одинаково близки → не привязываем автоматически.
  if (scored.length > 1 && scored[0].dist === scored[1].dist) {
    return { matched: false, reason: "ambiguous" };
  }
  return { matched: true, orderId: scored[0].c.orderId, partyRole: scored[0].role };
}
