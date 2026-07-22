/**
 * Публикация доменных событий в persistent outbox (замена fire-and-forget `eventBus.publish`).
 * Бизнес-код вызывает `publishEvent(repo, name, payload, ...)` — событие ГАРАНТИРОВАННО
 * сохраняется до обработки и не теряется при рестарте. Обработку выполняет отдельный worker.
 *
 * Типобезопасно завязано на реестр `DomainEventMap`. `aggregateType/aggregateId` и дефолтный
 * `idempotencyKey` выводятся из имени/payload события (переопределяемо).
 */
import type { DomainEventName, DomainEventMap } from "@/events/types";
import type { OutboxRepository, OutboxRecord } from "./types";

type Aggregate = { type: string; id: string };

/** Выводит агрегат события из payload (order.* → order/orderId; site-события → site/siteId). */
export function deriveAggregate<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): Aggregate {
  const p = payload as Record<string, unknown>;
  if (typeof p.orderId === "string") return { type: "order", id: p.orderId };
  if (typeof p.siteId === "string") return { type: "site", id: p.siteId };
  return { type: "unknown", id: "unknown" };
}

/**
 * Дефолтный idempotencyKey события. Для событий заказа включает orderId; для событий с
 * версией/статусом расширьте ключ на стороне вызова, чтобы разные переходы не схлопывались.
 */
export function defaultIdempotencyKey<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): string {
  const agg = deriveAggregate(name, payload);
  return `${name}:${agg.id}`;
}

export type PublishEventOptions = {
  /** Переопределить ключ дедупликации (по умолчанию `${name}:${aggregateId}`). */
  idempotencyKey?: string;
  aggregate?: Aggregate;
  maxAttempts?: number;
  /** Отложить обработку до указанного времени. */
  availableAt?: Date;
};

/** Сохраняет доменное событие в outbox. Идемпотентно по idempotencyKey. */
export async function publishEvent<K extends DomainEventName>(
  repo: OutboxRepository,
  name: K,
  payload: DomainEventMap[K],
  opts: PublishEventOptions = {}
): Promise<{ record: OutboxRecord; created: boolean }> {
  const aggregate = opts.aggregate ?? deriveAggregate(name, payload);
  return repo.enqueue({
    eventType: name,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: payload as unknown,
    idempotencyKey: opts.idempotencyKey ?? defaultIdempotencyKey(name, payload),
    maxAttempts: opts.maxAttempts,
    availableAt: opts.availableAt,
  });
}
