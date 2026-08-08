/**
 * Решение: можно ли СЕЙЧАС автоматически создавать Burq draft для заказа. Чистая функция.
 * Вызывается воркером при обработке отложенной outbox-задачи (повторная сверка на момент
 * фактического исполнения, а не на момент планирования).
 *
 * Возможные исходы:
 *  - CREATE_DRAFT     — все условия выполнены, создаём черновик;
 *  - WAIT_FOR_FLORIST — временно нельзя (нет флориста / pickup не настроен); задача переносится/ждёт;
 *  - SKIP             — создавать не нужно (выключено, заказ терминальный, draft уже есть).
 */
import { validatePickupLocation, type PickupLocationInput } from "./pickupValidation";
import { todayStrInTz } from "@/lib/tz";

export type EligibilityInput = {
  /** Site.burqDraftAutoCreateEnabled */
  siteAutoCreateEnabled: boolean;
  /** Глобальный feature-flag BURQ_ENABLED (реальные вызовы). Для планирования не обязателен. */
  orderStatus: string; // OrderStatus
  /** id назначенного флориста или null. */
  floristId: string | null | undefined;
  /** Pickup назначенного флориста (или null, если не настроен). */
  pickup: PickupLocationInput | null | undefined;
  /** Уже есть активная (текущая) Delivery с внешним draft? */
  hasCurrentDraft: boolean;
  /**
   * Дата доставки заказа. Если передана и уже прошла (день < сегодня) — АВТОсоздание черновика
   * пропускается (историю не диспатчим в Burq). Автопути (draftHandler/recovery) передают дату;
   * ручной ретрай — НЕ передаёт (сотрудник осознанно создаёт доставку и для прошедшей даты).
   */
  deliveryDate?: Date | null;
  /** Таймзона магазина. Без неё «сегодня» считается по UTC — см. isPastDeliveryDate. */
  timezone?: string | null;
  /** «Сейчас» — для сравнения даты доставки (инъекция в тестах). */
  now?: Date;
};

export type EligibilityDecision =
  | { action: "CREATE_DRAFT" }
  | { action: "WAIT_FOR_FLORIST"; reason: "no_florist" | "pickup_invalid" }
  | { action: "SKIP"; reason: "site_disabled" | "order_terminal" | "draft_exists" | "delivery_date_past" };

/** Заказы в этих статусах не требуют доставки — draft создавать не нужно. */
const TERMINAL_ORDER_STATUSES = new Set(["DELIVERED", "CANCELLED", "REFUNDED", "PROBLEM"]);

/**
 * Дата доставки уже прошла — по календарю МАГАЗИНА, а не по UTC.
 *
 * `deliveryDate` — UTC-полночь ЛОКАЛЬНОГО дня доставки, поэтому её собственный день берётся
 * прямо из ISO. А вот «сегодня» обязано считаться в таймзоне магазина: полночь UTC наступает
 * в Лос-Анджелесе в 17:00, и при сравнении по UTC любой вечерний заказ на сегодня выглядел
 * «вчерашним». Из-за этого автосоздание доставки молча пропускалось — PAR-41321 приняли в
 * 19:13 по местному времени в день доставки, и система решила, что день прошёл.
 */
export function isPastDeliveryDate(deliveryDate: Date, now: Date, timezone?: string | null): boolean {
  return deliveryDate.toISOString().slice(0, 10) < todayStrInTz(timezone, now);
}

export function decideDraftEligibility(input: EligibilityInput): EligibilityDecision {
  if (!input.siteAutoCreateEnabled) return { action: "SKIP", reason: "site_disabled" };
  if (input.hasCurrentDraft) return { action: "SKIP", reason: "draft_exists" };
  if (TERMINAL_ORDER_STATUSES.has(input.orderStatus)) return { action: "SKIP", reason: "order_terminal" };
  // Прошедшая дата доставки → не автосоздаём (защита от массового создания по историческому бэклогу
  // при включении автосоздания магазину). Только когда дата передана (авто-путь).
  if (input.deliveryDate && isPastDeliveryDate(input.deliveryDate, input.now ?? new Date(), input.timezone)) {
    return { action: "SKIP", reason: "delivery_date_past" };
  }

  if (!input.floristId) return { action: "WAIT_FOR_FLORIST", reason: "no_florist" };
  if (!validatePickupLocation(input.pickup).valid) return { action: "WAIT_FOR_FLORIST", reason: "pickup_invalid" };

  return { action: "CREATE_DRAFT" };
}
