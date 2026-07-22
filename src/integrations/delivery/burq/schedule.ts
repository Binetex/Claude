/**
 * Планирование автоматического создания Burq draft через ОТЛОЖЕННУЮ outbox-задачу.
 * Механизм — не периодический опрос, а задача с `availableAt`: worker'ский poll и есть
 * планировщик. Для будущей даты доставки задача становится доступной в `burqDraftCreationLocalTime`
 * (по умолчанию 04:00) локального дня доставки; для сегодняшней/просроченной — доступна сейчас.
 */
import { zonedLocalTimeToUtc, DEFAULT_STORE_TZ } from "@/lib/tz";

export const BURQ_DRAFT_CREATE_EVENT = "burq.draft.create.requested";

export type BurqDraftCreatePayload = {
  orderId: string;
  /** Версия расписания. При переносе даты — бумп; воркер отбрасывает устаревшие задачи. */
  scheduleVersion: number;
};

/**
 * Момент, когда задача создания черновика становится доступной (UTC). Чистая функция.
 *  - `deliveryDate` — UTC-полночь локального дня доставки (как хранит Order.deliveryDate);
 *  - `creationLocalTime` — "HH:mm" локального времени запуска (Site.burqDraftCreationLocalTime);
 *  - если рассчитанный момент уже в прошлом (сегодня/просрочка) → `now`.
 */
export function computeDraftAvailableAt(
  deliveryDate: Date,
  creationLocalTime: string,
  tz: string | null | undefined,
  now: Date = new Date()
): Date {
  const zone = tz || DEFAULT_STORE_TZ;
  // Order.deliveryDate — UTC-полночь ЛОКАЛЬНОГО дня доставки, поэтому локальный день —
  // это его UTC-календарная дата (пере-конвертация через tz сдвинула бы её на день).
  const localDay = deliveryDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const at = zonedLocalTimeToUtc(localDay, creationLocalTime || "04:00", zone);
  return at.getTime() <= now.getTime() ? now : at;
}

/** Стабильный ключ дедупликации outbox-задачи создания черновика (учитывает версию расписания). */
export function draftCreateIdempotencyKey(orderId: string, scheduleVersion: number): string {
  return `burq:draft:create:${orderId}:v${scheduleVersion}`;
}

export type ScheduleDeps = {
  enqueue(input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
    idempotencyKey: string;
    availableAt: Date;
    maxAttempts?: number;
  }): Promise<{ created: boolean }>;
};

export type ScheduleInput = {
  orderId: string;
  deliveryDate: Date;
  timezone: string | null | undefined;
  creationLocalTime: string;
  scheduleVersion: number;
  now?: Date;
  maxAttempts?: number;
};

/**
 * Ставит (идемпотентно) отложенную задачу создания Burq draft. Возвращает рассчитанный
 * `availableAt` и был ли создан новый outbox-элемент (created=false при дубле того же ключа).
 */
export async function scheduleBurqDraftForOrder(deps: ScheduleDeps, input: ScheduleInput): Promise<{ availableAt: Date; created: boolean }> {
  const availableAt = computeDraftAvailableAt(input.deliveryDate, input.creationLocalTime, input.timezone, input.now);
  const payload: BurqDraftCreatePayload = { orderId: input.orderId, scheduleVersion: input.scheduleVersion };
  const { created } = await deps.enqueue({
    eventType: BURQ_DRAFT_CREATE_EVENT,
    aggregateType: "order",
    aggregateId: input.orderId,
    payload,
    idempotencyKey: draftCreateIdempotencyKey(input.orderId, input.scheduleVersion),
    availableAt,
    maxAttempts: input.maxAttempts,
  });
  return { availableAt, created };
}
