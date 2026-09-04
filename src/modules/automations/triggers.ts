import type { DomainEventName } from "@/events/types";

/**
 * Централизованный app-registry триггеров авто-SMS. `triggerType` хранится в БД строкой и
 * валидируется ТОЛЬКО против этого реестра. Новый триггер добавляется здесь + публикацией
 * соответствующего доменного события — БЕЗ Prisma-миграции. Неизвестное значение (например,
 * старое правило после отката) не падает в UI и НЕ запускается (см. isSupportedTrigger).
 *
 * `requiredVars` — переменные, без непустого значения которых сообщение НЕ отправляется
 * (job → SKIPPED). Так TRACKING_LINK_AVAILABLE не уходит, пока трек реально не появился.
 */
export type SmsTriggerDef = {
  /** Стабильный ключ, хранится в Automation.triggerType. */
  type: string;
  label: string;
  description: string;
  /**
   * Доменное событие outbox, которое запускает этот триггер. Пусто у шага цепочки: его запускает
   * не событие заказа, а предыдущее правило, поимённо (см. modules/automations/replyWait.ts).
   */
  domainEvent?: DomainEventName;
  /** Обязательные непустые переменные (иначе SKIP). */
  requiredVars?: string[];
};

// MVP-триггеры. Расширение: добавить запись + гарантировать публикацию domainEvent.
export const SMS_TRIGGERS: readonly SmsTriggerDef[] = [
  {
    type: "ORDER_CREATED",
    label: "Заказ создан",
    description: "Сразу после первого появления заказа в системе (оплату задайте условием).",
    domainEvent: "order.created",
  },
  {
    type: "ORDER_PAID",
    label: "Заказ оплачен",
    description:
      "На переходе заказа в оплаченное состояние (включая подтверждённый BNPL — Klarna/Airwallex). Повторная синхронизация уже оплаченного заказа триггер НЕ запускает.",
    domainEvent: "order.paid",
  },
  {
    type: "ORDER_CANCELLED",
    label: "Заказ отменён",
    description: "На переходе заказа в отменённое состояние. Отмена по возврату — это отдельный триггер «Оформлен возврат».",
    domainEvent: "order.cancelled",
  },
  {
    type: "TRACKING_LINK_AVAILABLE",
    label: "Появился трек-номер",
    description: "Когда у доставки впервые появился tracking-ссылка курьера.",
    domainEvent: "order.delivery.started",
    requiredVars: ["tracking_url"],
  },
  {
    type: "DELIVERY_TODAY",
    label: "Доставка сегодня",
    description: "Каждый день в заданное время магазина (по умолчанию 9:00) — для всех заказов с доставкой в этот день.",
    domainEvent: "order.delivery.today",
  },
  {
    type: "CHAINED",
    label: "Запускается по цепочке",
    description:
      "Само по себе правило не срабатывает: его запускает другое правило, когда на его сообщение не ответили. Кто именно запускает — видно в том правиле, в поле «Если не ответят».",
  },
  {
    type: "PAYMENT_PENDING",
    label: "Оплата в ожидании (BNPL)",
    description: "Airwallex/Klarna приняли заказ, но подтверждение оплаты ещё не пришло. Только WooCommerce.",
    domainEvent: "order.payment.pending",
  },
  {
    type: "PAYMENT_FAILED",
    label: "Оплата не прошла",
    description: "Платёж отклонён (в т.ч. отказ Airwallex/Klarna). Только WooCommerce.",
    domainEvent: "order.payment.failed",
  },
  {
    type: "ORDER_REFUNDED",
    label: "Оформлен возврат",
    description: "Заказ полностью возвращён. Частичный возврат триггер не запускает.",
    domainEvent: "order.refunded",
  },
  {
    type: "ORDER_DELIVERED",
    label: "Заказ доставлен",
    description:
      "После подтверждения доставки — курьером (Burq), вручную владельцем или самой платформой (Shopify fulfilled / WooCommerce completed). Ровно один раз на заказ, каким бы из источников подтверждение ни пришло.",
    domainEvent: "order.delivery.completed",
  },
] as const;

const BY_TYPE = new Map(SMS_TRIGGERS.map((t) => [t.type, t]));

export function listSmsTriggers(): readonly SmsTriggerDef[] {
  return SMS_TRIGGERS;
}

/** Тип-заглушка шага цепочки: правило с ним запускает не событие, а другое правило. */
export const CHAINED_TRIGGER = "CHAINED";

/**
 * Триггеры для МАРКЕТИНГОВЫХ ЦЕПОЧЕК (Automation Flows). Шага цепочки правил здесь нет:
 * Flows запускаются только событиями заказа, и цепочка с `CHAINED` не сработала бы никогда —
 * владелец выбрал бы её, сохранил и ждал впустую.
 */
export function listFlowTriggers(): readonly SmsTriggerDef[] {
  return SMS_TRIGGERS.filter((t) => t.type !== CHAINED_TRIGGER);
}

export function getSmsTrigger(type: string): SmsTriggerDef | null {
  return BY_TYPE.get(type) ?? null;
}

export function isSupportedTrigger(type: string): boolean {
  return BY_TYPE.has(type);
}
