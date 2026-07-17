/**
 * Маппинг статусов WooCommerce → внутренние enum Floremart. Чистая функция (без сети/БД),
 * покрыта тестами. WooCommerce статусы заказа: pending, processing, on-hold, completed,
 * cancelled, refunded, failed.
 *
 * Правила согласованы с деривацией статусов Shopify (см. shopify/ingestOrder.deriveOrderState),
 * чтобы поведение между платформами не разъезжалось:
 *  - cancelled            → CANCELLED;
 *  - completed            → DELIVERED (+ доставка DELIVERED);
 *  - оплачен (processing) → CONFIRMED (требует назначения флориста);
 *  - иначе                → AWAITING_PAYMENT.
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
      return { payment: "REFUNDED", order: "CONFIRMED", delivery: null };
    case "cancelled":
    case "failed":
      return { payment: "UNPAID", order: "CANCELLED", delivery: null };
    case "pending":
    case "on-hold":
    default:
      return { payment: "UNPAID", order: "AWAITING_PAYMENT", delivery: null };
  }
}
