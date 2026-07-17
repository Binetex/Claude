/**
 * Реестр доменных событий Floremart. Единый типизированный контракт: имя события →
 * форма payload. Публикаторы и подписчики зависят от этих типов, а не от конкретной
 * реализации шины — поэтому in-process реализацию (`bus.ts`) можно позже заменить на
 * Redis/BullMQ без изменения бизнес-кода.
 *
 * Payload'ы «тонкие»: несут идентификаторы и минимум данных, а не целые агрегаты, чтобы
 * подписчик читал актуальное состояние сам (иначе события устаревают).
 */
import type { IntegrationPlatform } from "@/integrations/normalized";

export type DomainEventMap = {
  "order.created": { orderId: string; platform: IntegrationPlatform | null };
  "order.updated": { orderId: string; changed: string[] };
  "order.assigned": { orderId: string; floristId: string };
  "order.ready": { orderId: string; floristId: string | null };
  "order.delivery.started": { orderId: string; trackingUrl: string | null };
  "order.delivery.completed": { orderId: string };
  "order.cancelled": { orderId: string; reason: string | null };
  "order.refunded": { orderId: string; amount: number | null };
  "product.synced": { siteId: string; created: number; updated: number };
  "integration.connected": { siteId: string; platform: IntegrationPlatform };
  "integration.failed": { siteId: string; platform: IntegrationPlatform; error: string };
};

export type DomainEventName = keyof DomainEventMap;

/** Конверт события: payload + метаданные идемпотентности/повторов. */
export type EventEnvelope<K extends DomainEventName = DomainEventName> = {
  name: K;
  payload: DomainEventMap[K];
  /** Стабильный ключ дедупликации (напр. `${name}:${orderId}:${version}`). */
  idempotencyKey: string;
  occurredAt: string; // ISO
  /** Номер попытки доставки этого события (для метаданных повторов). */
  attempt: number;
};

/** Подписчик на событие. Должен быть идемпотентным по `envelope.idempotencyKey`. */
export type EventHandler<K extends DomainEventName = DomainEventName> = (
  payload: DomainEventMap[K],
  envelope: EventEnvelope<K>
) => Promise<void> | void;

/** Запись журнала обработки одного хендлера. */
export type EventLogEntry = {
  name: DomainEventName;
  idempotencyKey: string;
  handler: string;
  ok: boolean;
  error?: string;
  attempt: number;
  at: string; // ISO
};
