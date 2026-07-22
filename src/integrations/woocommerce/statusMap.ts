/**
 * Маппинг статусов WooCommerce → внутренние enum Floremart. Чистая функция (без сети/БД),
 * покрыта тестами. WooCommerce статусы заказа: pending, processing, on-hold, completed,
 * cancelled, refunded, failed.
 *
 * Правила согласованы с деривацией статусов Shopify (см. shopify/ingestOrder.deriveOrderState),
 * чтобы поведение между платформами не разъезжалось:
 *  - cancelled / failed   → CANCELLED;
 *  - refunded             → CANCELLED (полный возврат в Woo терминален; заказ НЕ должен
 *                           возвращаться в активную работу — оплата помечается REFUNDED);
 *  - completed            → DELIVERED (+ доставка DELIVERED);
 *  - оплачен (processing) → CONFIRMED (требует назначения флориста);
 *  - иначе                → AWAITING_PAYMENT.
 *
 * ЧЕРНОВИК: финальные бизнес-правила маппинга Woo подтверждает владелец (см.
 * docs/AUTONOMOUS_REFACTOR_REPORT.md / REFACTOR_BACKLOG.md).
 */
import type { NormalizedExternalStatus } from "@/integrations/normalized";

export type WooOrderStatus =
  | "pending"
  | "processing"
  | "on-hold"
  | "completed"
  | "cancelled"
  | "refunded"
  | "failed"
  | (string & {}); // допускаем неизвестные статусы, не падая

export function mapWooStatus(status: WooOrderStatus): NormalizedExternalStatus {
  switch (status) {
    case "completed":
      return { payment: "PAID", order: "DELIVERED", delivery: "DELIVERED" };
    case "processing":
      return { payment: "PAID", order: "CONFIRMED", delivery: null };
    case "refunded":
      // Полный возврат терминален: помечаем оплату REFUNDED, но заказ CANCELLED —
      // иначе refunded-заказ всплыл бы на дашборде как активная работа.
      return { payment: "REFUNDED", order: "CANCELLED", delivery: null };
    case "cancelled":
    case "failed":
      return { payment: "UNPAID", order: "CANCELLED", delivery: null };
    case "pending":
    case "on-hold":
    default:
      return { payment: "UNPAID", order: "AWAITING_PAYMENT", delivery: null };
  }
}
