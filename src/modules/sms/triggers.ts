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
  /** Стабильный ключ, хранится в SmsAutomation.triggerType. */
  type: string;
  label: string;
  description: string;
  /** Доменное событие outbox, которое запускает этот триггер. */
  domainEvent: DomainEventName;
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
    type: "TRACKING_LINK_AVAILABLE",
    label: "Появился трек-номер",
    description: "Когда у доставки впервые появился tracking-ссылка курьера.",
    domainEvent: "order.delivery.started",
    requiredVars: ["tracking_url"],
  },
  {
    type: "ORDER_DELIVERED",
    label: "Заказ доставлен",
    description: "После подтверждения доставки (можно с задержкой — напр. просьба об отзыве).",
    domainEvent: "order.delivery.completed",
  },
] as const;

const BY_TYPE = new Map(SMS_TRIGGERS.map((t) => [t.type, t]));

export function listSmsTriggers(): readonly SmsTriggerDef[] {
  return SMS_TRIGGERS;
}

export function getSmsTrigger(type: string): SmsTriggerDef | null {
  return BY_TYPE.get(type) ?? null;
}

export function isSupportedTrigger(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Все триггеры, привязанные к данному доменному событию (сейчас 1:1, но поддерживаем N). */
export function triggersForEvent(event: DomainEventName): SmsTriggerDef[] {
  return SMS_TRIGGERS.filter((t) => t.domainEvent === event);
}
