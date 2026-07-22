import type { TelegramAudience } from "./config";

/**
 * Центральный реестр типов внутренних Telegram-уведомлений. Новое уведомление добавляется
 * ЗАПИСЬЮ ЗДЕСЬ, а не копированием кода отправки: обработчик один на все типы.
 *
 * `dedupeKey` определяет, что считать «одним и тем же сообщением»:
 *  - основное сообщение флористам по заказу — одно на заказ, обновляется через editMessage
 *    (новое назначение и передача другому флористу правят его, а не плодят дубли);
 *  - основное сообщение владельцу о новом заказе — отдельное, флористским не затирается;
 *  - срочные уведомления владельцу (оплата/доставка) имеют СВОИ ключи и не затирают основное.
 */
/**
 * ЗАРЕЗЕРВИРОВАНО на будущее, НЕ реализовано: "payment.pending_too_long" — Airwallex/Klarna
 * висит в ожидании дольше порога. Требует отложенной проверки по каждому заказу; постоянный
 * скан заказов сознательно не делаем.
 */
export const TELEGRAM_EVENTS = [
  "order.assigned",
  "order.reassigned",
  "order.created",
  "payment.failed",
  "delivery.problem",
] as const;

export type TelegramEventType = (typeof TELEGRAM_EVENTS)[number];

export type TelegramEventDef = {
  type: TelegramEventType;
  audience: TelegramAudience;
  /** Ключ основного сообщения: одинаковый ключ → редактируем существующее. */
  dedupeKey: (orderId: string) => string;
  description: string;
};

const REGISTRY: Record<TelegramEventType, TelegramEventDef> = {
  "order.assigned": {
    type: "order.assigned",
    audience: "FLORIST",
    dedupeKey: (orderId) => `order:${orderId}:florist`,
    description: "Заказ назначен флористу (авто или вручную).",
  },
  "order.reassigned": {
    type: "order.reassigned",
    audience: "FLORIST",
    // ТОТ ЖЕ ключ, что у order.assigned: при передаче заказа правим существующее сообщение.
    dedupeKey: (orderId) => `order:${orderId}:florist`,
    description: "Заказ передан другому флористу — обновляет то же сообщение.",
  },
  "order.created": {
    type: "order.created",
    audience: "OWNER",
    dedupeKey: (orderId) => `order:${orderId}:owner`,
    description: "Новый заказ (включая неоплаченные) — владельцу для наблюдения за потоком.",
  },
  "payment.failed": {
    type: "payment.failed",
    audience: "OWNER",
    dedupeKey: (orderId) => `order:${orderId}:owner.payment`,
    description: "Платёж отклонён (PAYMENT_FAILED).",
  },
  "delivery.problem": {
    type: "delivery.problem",
    audience: "OWNER",
    dedupeKey: (orderId) => `order:${orderId}:owner.delivery`,
    description: "Доставка перешла в FAILED / CANCELLED / PROBLEM.",
  },
};

export function getTelegramEvent(type: string): TelegramEventDef | null {
  return (REGISTRY as Record<string, TelegramEventDef | undefined>)[type] ?? null;
}

export function listTelegramEvents(): TelegramEventDef[] {
  return TELEGRAM_EVENTS.map((t) => REGISTRY[t]);
}
