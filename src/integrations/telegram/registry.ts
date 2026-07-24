import type { TelegramAudience } from "./config";

/**
 * Центральный реестр типов внутренних Telegram-уведомлений. Новое уведомление добавляется
 * ЗАПИСЬЮ ЗДЕСЬ, а не копированием кода отправки: обработчик один на все типы.
 *
 * `dedupeKey` определяет, что считать «одним и тем же сообщением». Для флористов ключ включает
 * floristId: у каждого свой бот и свой чат, поэтому «одно сообщение на заказ» существует в
 * пределах одного флориста. При передаче заказа прежний получает пометку в СВОЁМ сообщении,
 * новый — отдельное новое от своего бота.
 *
 * ЗАРЕЗЕРВИРОВАНО, НЕ реализовано: "payment.pending_too_long" — BNPL висит дольше порога.
 * Требует отложенной проверки по каждому заказу; постоянный скан заказов делать не хотим.
 */
export const TELEGRAM_EVENTS = [
  "order.assigned",
  "order.handed_over",
  "order.created",
  "payment.failed",
  "payment.pending_too_long",
  "payment.status_mismatch",
  "payment.not_found",
  "delivery.problem",
] as const;

export type TelegramEventType = (typeof TELEGRAM_EVENTS)[number];

export type DedupeContext = { orderId: string; floristId?: string | null };

export type TelegramEventDef = {
  type: TelegramEventType;
  audience: TelegramAudience;
  /** Требует ли событие конкретного флориста (и, значит, его персонального бота). */
  perFlorist: boolean;
  dedupeKey: (ctx: DedupeContext) => string;
  description: string;
};

const REGISTRY: Record<TelegramEventType, TelegramEventDef> = {
  "order.assigned": {
    type: "order.assigned",
    audience: "FLORIST",
    perFlorist: true,
    dedupeKey: ({ orderId, floristId }) => `order:${orderId}:florist:${floristId}`,
    description: "Заказ назначен флористу — его личным ботом в его чат.",
  },
  "order.handed_over": {
    type: "order.handed_over",
    audience: "FLORIST",
    perFlorist: true,
    // ТОТ ЖЕ ключ, что у order.assigned для этого флориста: правим его собственное сообщение.
    dedupeKey: ({ orderId, floristId }) => `order:${orderId}:florist:${floristId}`,
    description: "Заказ забрали у флориста — его сообщение помечается «передан».",
  },
  "order.created": {
    type: "order.created",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner`,
    description: "Новый заказ (включая неоплаченные) — владельцу для наблюдения за потоком.",
  },
  "payment.failed": {
    type: "payment.failed",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.payment`,
    description: "Платёж отклонён (PAYMENT_FAILED).",
  },
  "payment.pending_too_long": {
    type: "payment.pending_too_long",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.pending_long`,
    description: "Платёж Airwallex висит в ожидании дольше порога магазина.",
  },
  "payment.status_mismatch": {
    type: "payment.status_mismatch",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.mismatch`,
    description: "Статус оплаты в Airwallex расходится с WooCommerce.",
  },
  "payment.not_found": {
    type: "payment.not_found",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.not_found`,
    description: "Платёж не найден в Airwallex после нескольких попыток.",
  },
  "delivery.problem": {
    type: "delivery.problem",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.delivery`,
    description: "Доставка перешла в FAILED / CANCELLED / PROBLEM.",
  },
};

export function getTelegramEvent(type: string): TelegramEventDef | null {
  return (REGISTRY as Record<string, TelegramEventDef | undefined>)[type] ?? null;
}

export function listTelegramEvents(): TelegramEventDef[] {
  return TELEGRAM_EVENTS.map((t) => REGISTRY[t]);
}
