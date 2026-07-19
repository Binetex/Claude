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
};

export type EligibilityDecision =
  | { action: "CREATE_DRAFT" }
  | { action: "WAIT_FOR_FLORIST"; reason: "no_florist" | "pickup_invalid" }
  | { action: "SKIP"; reason: "site_disabled" | "order_terminal" | "draft_exists" };

/** Заказы в этих статусах не требуют доставки — draft создавать не нужно. */
const TERMINAL_ORDER_STATUSES = new Set(["DELIVERED", "CANCELLED", "REFUNDED", "PROBLEM"]);

export function decideDraftEligibility(input: EligibilityInput): EligibilityDecision {
  if (!input.siteAutoCreateEnabled) return { action: "SKIP", reason: "site_disabled" };
  if (input.hasCurrentDraft) return { action: "SKIP", reason: "draft_exists" };
  if (TERMINAL_ORDER_STATUSES.has(input.orderStatus)) return { action: "SKIP", reason: "order_terminal" };

  if (!input.floristId) return { action: "WAIT_FOR_FLORIST", reason: "no_florist" };
  if (!validatePickupLocation(input.pickup).valid) return { action: "WAIT_FOR_FLORIST", reason: "pickup_invalid" };

  return { action: "CREATE_DRAFT" };
}
