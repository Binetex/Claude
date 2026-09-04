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
  "delivery.problem_florist",
  "delivery.no_couriers",
  "delivery.no_couriers_florist",
  "order.ask_review",
  "customer.ready_time",
  "customer.ready_time_florist",
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
    description: "Доставка перешла в FAILED / CANCELLED / PROBLEM — владельцу.",
  },
  "delivery.problem_florist": {
    type: "delivery.problem_florist",
    audience: "FLORIST",
    perFlorist: true,
    // Зеркало owner-события: та же проблема, но личным ботом флориста в его чат.
    dedupeKey: ({ orderId, floristId }) => `order:${orderId}:florist:${floristId}:delivery`,
    description: "Проблема доставки — флористу заказа его личным ботом.",
  },
  "order.ask_review": {
    type: "order.ask_review",
    audience: "CUSTOMER_SERVICE",
    perFlorist: false,
    // Один заказ — одна задача. Владелец может снять и снова поставить пометку; второе
    // сообщение оператору об одном и том же заказе было бы шумом.
    dedupeKey: ({ orderId }) => `order:${orderId}:cs.ask_review`,
    description: "Владелец пометил заказ «попросить отзыв» — задача оператору колл-центра.",
  },
  "delivery.no_couriers": {
    type: "delivery.no_couriers",
    audience: "OWNER",
    perFlorist: false,
    // Ключ включает попытку: новая попытка доставки — это новая проверка и новый повод
    // сказать, а не редактирование старого сообщения.
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.no_couriers`,
    description: "При создании черновика Burq не вернул ни одного провайдера на маршрут — владельцу.",
  },
  "delivery.no_couriers_florist": {
    type: "delivery.no_couriers_florist",
    audience: "FLORIST",
    perFlorist: true,
    dedupeKey: ({ orderId, floristId }) => `order:${orderId}:florist:${floristId}:no_couriers`,
    description: "Курьеров на маршрут не нашлось — флористу заказа: букет остаётся у него.",
  },
  // Клиент ответил, когда готов принять букет. Ключ включает само сообщение (occurrenceKey из
  // публикации): назвал время дважды — два уведомления, а не правка первого.
  "customer.ready_time": {
    type: "customer.ready_time",
    audience: "OWNER",
    perFlorist: false,
    dedupeKey: ({ orderId }) => `order:${orderId}:owner.ready_time`,
    description: "Клиент написал, когда готов принять доставку — владельцу.",
  },
  "customer.ready_time_florist": {
    type: "customer.ready_time_florist",
    audience: "FLORIST",
    perFlorist: true,
    dedupeKey: ({ orderId, floristId }) => `order:${orderId}:florist:${floristId}:ready_time`,
    description: "Клиент написал, когда готов принять доставку — флористу, который везёт.",
  },
};

export function getTelegramEvent(type: string): TelegramEventDef | null {
  return (REGISTRY as Record<string, TelegramEventDef | undefined>)[type] ?? null;
}

export function listTelegramEvents(): TelegramEventDef[] {
  return TELEGRAM_EVENTS.map((t) => REGISTRY[t]);
}
