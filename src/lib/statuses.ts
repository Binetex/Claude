import type {
  OrderStatus,
  PaymentStatus,
  AssignmentStatus,
  DeliveryStatus,
  SyncStatus,
} from "@/generated/prisma/enums";

type Meta = { label: string; className: string };

// Семантические тоны статусов — вместо «радуги» из 11 цветов кодируем СМЫСЛ:
// нейтральный (покой), info (в работе), success (готово/доставлено), danger (проблема).
const TONE = {
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
  info: "bg-blue-50 text-blue-700 border-blue-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  danger: "bg-red-50 text-red-700 border-red-200",
} as const;

export const orderStatusMeta: Record<OrderStatus, Meta> = {
  AWAITING_PAYMENT: { label: "Ожидает оплаты", className: TONE.neutral },
  CONFIRMED: { label: "Подтверждён", className: TONE.neutral },
  ASSIGNED: { label: "Назначен флористу", className: TONE.info },
  FLORIST_ACCEPTED: { label: "Флорист принял", className: TONE.info },
  IN_PROGRESS: { label: "В работе", className: TONE.info },
  READY: { label: "Готов", className: TONE.success },
  AWAITING_COURIER: { label: "Ожидает курьера", className: TONE.info },
  IN_TRANSIT: { label: "В пути", className: TONE.info },
  DELIVERED: { label: "Доставлен", className: TONE.success },
  PROBLEM: { label: "Проблема", className: TONE.danger },
  CANCELLED: { label: "Отменён", className: TONE.neutral },
};

/**
 * Метка статуса заказа с UI-различием «оплата не прошла» (WooCommerce `failed`) от обычного
 * ожидания оплаты. Отдельного enum/миграции НЕ вводим: Woo `failed` уже маппится в
 * AWAITING_PAYMENT (paymentStatus остаётся UNPAID, флорист/Burq/автовыполнение не запускаются),
 * а здесь лишь показываем «Ошибка оплаты» вместо «Ожидает оплаты». Флаг берётся из уже
 * сохранённых полей заказа (externalStatus="failed" / paymentClassification="PAYMENT_FAILED").
 * Если Woo позже переведёт заказ в processing/completed — эти поля обновятся, и метка вернётся к норме.
 */
export function resolveOrderStatusMeta(status: OrderStatus, opts?: { paymentFailed?: boolean }): Meta {
  if (status === "AWAITING_PAYMENT" && opts?.paymentFailed) {
    return { label: "Ошибка оплаты", className: TONE.danger };
  }
  return orderStatusMeta[status];
}

export const paymentStatusMeta: Record<PaymentStatus, Meta> = {
  UNPAID: { label: "Не оплачен", className: "bg-amber-100 text-amber-800 border-amber-200" },
  PAID: { label: "Оплачен", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  PAY_LATER_APPROVED: { label: "Оплата позже (одобрено)", className: "bg-teal-100 text-teal-800 border-teal-200" },
  REFUNDED: { label: "Возврат", className: "bg-slate-200 text-slate-700 border-slate-300" },
  PARTIALLY_REFUNDED: { label: "Частичный возврат", className: "bg-orange-100 text-orange-800 border-orange-200" },
};

export const assignmentStatusMeta: Record<AssignmentStatus, Meta> = {
  UNASSIGNED: { label: "Требует назначения", className: "bg-red-100 text-red-800 border-red-200" },
  ASSIGNED: { label: "Ожидает принятия", className: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  ACCEPTED: { label: "Принят флористом", className: "bg-violet-100 text-violet-800 border-violet-200" },
};

export const deliveryStatusMeta: Record<DeliveryStatus, Meta> = {
  PENDING: { label: "Ожидает", className: "bg-slate-100 text-slate-700 border-slate-200" },
  SCHEDULED: { label: "Запланирована", className: "bg-sky-100 text-sky-800 border-sky-200" },
  IN_TRANSIT: { label: "В пути", className: "bg-purple-100 text-purple-800 border-purple-200" },
  DELIVERED: { label: "Доставлена", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  FAILED: { label: "Сбой доставки", className: "bg-red-100 text-red-800 border-red-200" },
};

export const syncStatusMeta: Record<SyncStatus, Meta> = {
  LOCAL: { label: "Локальный", className: "bg-slate-100 text-slate-700 border-slate-200" },
  SYNCED: { label: "Синхронизирован", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  PENDING: { label: "Синхронизация…", className: "bg-amber-100 text-amber-800 border-amber-200" },
  ERROR: { label: "Ошибка синхр.", className: "bg-red-100 text-red-800 border-red-200" },
};

// Терминальные статусы: заказ завершён (выполнен) или отменён. Такие заказы не считаются
// активными и не требуют назначения флориста (см. metrics/florists/assignments).
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["DELIVERED", "CANCELLED"];

// Статусы, которые владелец/колл-центр может выставлять вручную (не через действия флориста).
export const manualOrderStatuses: OrderStatus[] = [
  "CONFIRMED",
  "IN_PROGRESS",
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED",
];
