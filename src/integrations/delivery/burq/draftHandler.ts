/**
 * Orchestration отложенной задачи `burq.draft.create.requested`. Чистая логика координации:
 * загрузить контекст → сверить версию расписания → решить eligibility → создать Burq draft
 * (mock/real за флагом) → сохранить Delivery/Intent/событие. Персистентность и БД спрятаны
 * за портом `DraftCreatePort`, поэтому оркестрация тестируется без живой БД.
 *
 * Правила: pickup только из локации назначенного флориста; при отсутствии флориста/pickup —
 * WAITING_FOR_FLORIST (без авто-ретрая здесь; перепланирование — при назначении флориста).
 */
import type { BurqClient } from "./client";
import { decideDraftEligibility } from "./eligibility";
import { buildBurqDraftRequest, DEFAULT_BURQ_DIMENSIONS, type DraftOrderInput, type PickupInput, type BurqDimensions } from "./request";
import type { PickupLocationInput } from "./pickupValidation";
import type { BurqDraftCreatePayload } from "./schedule";
import { checkCourierAvailability, probeExternalRef } from "./courierCheck";

/** Контекст, необходимый для решения и создания черновика (без лишних PII-полей). */
export type DraftContext = {
  order: {
    id: string;
    orderStatus: string;
    scheduleVersion: number; // текущая версия расписания (из DeliveryIntent)
    siteAutoCreateEnabled: boolean;
    deliveryDate: Date | null; // для guard'а прошедшей даты (авто-путь)
    dropoff: DraftOrderInput;
  };
  floristId: string | null;
  pickup: (PickupInput & PickupLocationInput) | null;
  /** id выбранной точки (снимок для Delivery). null, если точка не выбрана. */
  pickupLocationId: string | null;
  hasCurrentDraft: boolean;
  /** Номер следующей попытки доставки (для reference_id и idempotency-key внешнего POST). */
  nextAttemptNumber: number;
  /** Глобальные order-level размеры (из BurqSettings). Опционально → дефолт. */
  dimensions?: BurqDimensions;
};

export type PersistDraftInput = {
  orderId: string;
  floristId: string;
  /** Точка, которая фактически ушла в Burq (снимок). */
  pickupLocationId: string | null;
  attemptNumber: number;
  externalDeliveryId: string;
  checkoutUrl: string | null;
  rawStatus: string;
  referenceId: string;
};

/** Итог проверки курьеров. Пишется только когда проверка ДОСТОВЕРНО состоялась. */
export type CourierAvailabilityInput = {
  orderId: string;
  attemptNumber: number;
  /** 0 — маршрут никто не берётся везти. */
  count: number;
  hasUber: boolean;
  providers: string[];
};

export interface DraftCreatePort {
  loadContext(orderId: string): Promise<DraftContext | null>;
  /** Обновить DeliveryIntent (skip/wait). reason — машинный код без PII. */
  markIntent(orderId: string, status: "SKIPPED" | "WAITING_FOR_FLORIST", reason: string): Promise<void>;
  /** Транзакционно: создать Delivery (isCurrentAttempt), обновить Intent→DRAFT_CREATED, записать событие. */
  persistDraft(input: PersistDraftInput): Promise<void>;
  /** Записать результат проверки курьеров и, если их нет, поднять тревогу. */
  recordCourierAvailability(input: CourierAvailabilityInput): Promise<void>;
}

export type DraftHandlerResult =
  | { outcome: "created"; externalDeliveryId: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "waiting"; reason: string }
  | { outcome: "stale" }
  | { outcome: "order_missing" };

export type DraftHandlerDeps = {
  client: BurqClient;
  port: DraftCreatePort;
  log?: (event: string, extra?: Record<string, unknown>) => void;
};

/** Внешний idempotency-key для POST create (отдельно от outbox-ключа): попытка, не версия. */
export function externalCreateIdempotencyKey(orderId: string, attemptNumber: number): string {
  return `burq:create:${orderId}:${attemptNumber}`;
}

export async function handleBurqDraftCreate(deps: DraftHandlerDeps, payload: BurqDraftCreatePayload): Promise<DraftHandlerResult> {
  const log = deps.log ?? (() => {});
  const ctx = await deps.port.loadContext(payload.orderId);
  if (!ctx) {
    log("burq.draft.order_missing", { orderId: payload.orderId });
    return { outcome: "order_missing" };
  }

  // Version-check: устаревшую задачу (доставка перенесена) игнорируем.
  if (payload.scheduleVersion < ctx.order.scheduleVersion) {
    log("burq.draft.stale", { orderId: payload.orderId, taskVersion: payload.scheduleVersion, current: ctx.order.scheduleVersion });
    return { outcome: "stale" };
  }

  const decision = decideDraftEligibility({
    siteAutoCreateEnabled: ctx.order.siteAutoCreateEnabled,
    orderStatus: ctx.order.orderStatus,
    floristId: ctx.floristId,
    pickup: ctx.pickup,
    hasCurrentDraft: ctx.hasCurrentDraft,
    deliveryDate: ctx.order.deliveryDate, // авто-путь: прошедшую дату не создаём
  });

  if (decision.action === "SKIP") {
    await deps.port.markIntent(payload.orderId, "SKIPPED", decision.reason);
    log("burq.draft.skipped", { orderId: payload.orderId, reason: decision.reason });
    return { outcome: "skipped", reason: decision.reason };
  }

  if (decision.action === "WAIT_FOR_FLORIST") {
    await deps.port.markIntent(payload.orderId, "WAITING_FOR_FLORIST", decision.reason);
    log("burq.draft.waiting", { orderId: payload.orderId, reason: decision.reason });
    return { outcome: "waiting", reason: decision.reason };
  }

  // CREATE_DRAFT — florist и pickup гарантированно валидны (проверено eligibility).
  const floristId = ctx.floristId!;
  const attempt = ctx.nextAttemptNumber;
  const referenceId = `${ctx.order.id}:a${attempt}`;
  const req = buildBurqDraftRequest(referenceId, ctx.order.dropoff, ctx.pickup!, ctx.dimensions ?? DEFAULT_BURQ_DIMENSIONS);
  const idempotencyKey = externalCreateIdempotencyKey(ctx.order.id, attempt);

  const res = await deps.client.createDraft(req, idempotencyKey); // throw → outbox retry
  await deps.port.persistDraft({
    orderId: ctx.order.id,
    floristId,
    pickupLocationId: ctx.pickupLocationId,
    attemptNumber: attempt,
    externalDeliveryId: res.id,
    checkoutUrl: res.checkoutUrl,
    rawStatus: res.status,
    referenceId,
  });
  // Проверка курьеров идёт ПОСЛЕ сохранения черновика и ничего не может сломать: любая её
  // ошибка оставляет «не проверяли» и молчит. Тревога — только по достоверному пустому ответу.
  const check = await checkCourierAvailability(deps.client, req, probeExternalRef(ctx.order.id, attempt));
  if (check.checked) {
    try {
      await deps.port.recordCourierAvailability({
        orderId: ctx.order.id,
        attemptNumber: attempt,
        count: check.availability.count,
        hasUber: check.availability.hasUber,
        providers: check.availability.providers,
      });
    } catch {
      /* запись результата — не повод ронять уже созданный черновик */
    }
    log("burq.couriers.checked", { orderId: ctx.order.id, count: check.availability.count, hasUber: check.availability.hasUber });
  } else {
    log("burq.couriers.check_skipped", { orderId: ctx.order.id, reason: check.reason });
  }

  log("burq.draft.created", { orderId: ctx.order.id, attempt, mode: deps.client.mode });
  return { outcome: "created", externalDeliveryId: res.id };
}
