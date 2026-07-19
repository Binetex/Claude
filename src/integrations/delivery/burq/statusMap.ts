/**
 * Маппинг статусов Burq → нормализованный DeliveryProviderStatus → OrderStatus. Чистые функции.
 * Бизнес-логика НЕ привязана к строкам Burq. Неизвестный статус → UNKNOWN (без падения).
 *
 * Официальные Burq-статусы (getorderv2): request, delivery_created, driver_not_assigned,
 * driver_assigned, enroute_pickup, arrived_at_pickup, pickup_complete, enroute_dropoff,
 * arrived_at_dropoff, dropoff_complete, delivered, provider_canceled, customer_canceled,
 * burq_canceled, failed, disputed, enroute_to_return, returned.
 *
 * Особый случай: "attempting reroute" — в НАШЕМ процессе означает зависшую проблему →
 * PROBLEM, terminal-like для автоматики (не ждём авто-восстановления, не publish, не polling).
 */
import type { DeliveryProviderStatus, OrderStatus } from "@/generated/prisma/enums";

/** Нормализует сырую строку статуса: lowercase, пробелы/дефисы → "_". */
function norm(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const MAP: Record<string, DeliveryProviderStatus> = {
  request: "DRAFT_CREATED", // создан, но не инициирован (черновик)
  delivery_created: "SCHEDULED",
  driver_not_assigned: "SCHEDULED",
  driver_assigned: "COURIER_ASSIGNED",
  enroute_pickup: "COURIER_EN_ROUTE_TO_PICKUP",
  arrived_at_pickup: "AT_PICKUP",
  pickup_complete: "PICKED_UP",
  enroute_dropoff: "IN_TRANSIT",
  arrived_at_dropoff: "IN_TRANSIT",
  dropoff_complete: "IN_TRANSIT",
  delivered: "DELIVERED",
  provider_canceled: "CANCELLED",
  customer_canceled: "CANCELLED",
  burq_canceled: "CANCELLED",
  failed: "FAILED",
  disputed: "PROBLEM",
  enroute_to_return: "RETURNING",
  returned: "RETURNED",
  attempting_reroute: "PROBLEM", // зависшая проблема
};

/** Сырой Burq-статус → нормализованный. Неизвестный → UNKNOWN. */
export function mapBurqStatus(raw: string | null | undefined): DeliveryProviderStatus {
  if (!raw) return "UNKNOWN";
  return MAP[norm(raw)] ?? "UNKNOWN";
}

/** Терминальные для АВТОМАТИКИ статусы (polling прекращается, авто-обработка стоп). */
const AUTOMATION_TERMINAL = new Set<DeliveryProviderStatus>([
  "DELIVERED",
  "CANCELLED",
  "FAILED",
  "RETURNED",
  "PROBLEM", // attempting reroute — не ждём авто-восстановления
]);

export function isAutomationTerminal(status: DeliveryProviderStatus): boolean {
  return AUTOMATION_TERMINAL.has(status);
}

/**
 * Какой OrderStatus выставить для нормализованного статуса доставки. null — не менять Order.
 *  - черновик/планирование → не трогаем Order;
 *  - назначен курьер/едет на pickup → AWAITING_COURIER;
 *  - забрал/в пути → IN_TRANSIT;
 *  - доставлено → DELIVERED;
 *  - ПРОБЛЕМА/ошибка/возврат доставки → null: это проблема ДОСТАВКИ, а не производственного
 *    статуса заказа. Красная плашка рисуется по Delivery.status=PROBLEM, а Order.orderStatus
 *    автоматически НЕ меняется (в т.ч. `attempting reroute`);
 *  - отмена доставки → НЕ отменяем Order автоматически (null).
 */
export function orderStatusForDelivery(status: DeliveryProviderStatus): OrderStatus | null {
  switch (status) {
    case "DRAFT_PENDING":
    case "DRAFT_CREATED":
    case "SCHEDULED":
      return null;
    case "COURIER_ASSIGNED":
    case "COURIER_EN_ROUTE_TO_PICKUP":
    case "AT_PICKUP":
      return "AWAITING_COURIER";
    case "PICKED_UP":
    case "IN_TRANSIT":
      return "IN_TRANSIT";
    case "DELIVERED":
      return "DELIVERED";
    // Проблемы/ошибки/возвраты доставки НЕ меняют производственный статус заказа.
    case "PROBLEM":
    case "FAILED":
    case "RETURNING":
    case "RETURNED":
    case "CANCEL_REQUESTED":
    case "CANCELLED":
    case "UNKNOWN":
    default:
      return null;
  }
}

/** DELIVERED — единственный статус, публикующий order.delivery.completed. */
export function isDeliveredStatus(status: DeliveryProviderStatus): boolean {
  return status === "DELIVERED";
}
