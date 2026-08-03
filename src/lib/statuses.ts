import type {
  OrderStatus,
  PaymentStatus,
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

/**
 * Заказ у флориста — три значения enum, но ДВА разных смысла:
 *
 *  - ASSIGNED / FLORIST_ACCEPTED — «Принят»: заказ закреплён за флористом. ASSIGNED —
 *    легаси старого flow (assign + отдельное «принять»), новых не появляется;
 *    FLORIST_ACCEPTED ставит текущее назначение с авто-принятием. Для человека это одно
 *    и то же, поэтому в интерфейсе они под одной меткой.
 *  - IN_PROGRESS — «Начат»: флорист сел за букет. Отдельный смысл, а не синоним: по
 *    переходу «Принят → Начат» когда-нибудь можно будет мерить, сколько заказ пролежал.
 *
 * В БД значения остаются как есть — миграция ради переименования меток не нужна.
 */
export const ACCEPTED_ORDER_STATUSES: OrderStatus[] = ["ASSIGNED", "FLORIST_ACCEPTED"];

/** Всё, что «у флориста» — и принятое, и начатое. Для метрик и общих выборок. */
export const IN_WORK_ORDER_STATUSES: OrderStatus[] = [...ACCEPTED_ORDER_STATUSES, "IN_PROGRESS"];

export const orderStatusMeta: Record<OrderStatus, Meta> = {
  AWAITING_PAYMENT: { label: "Ожидает оплаты", className: TONE.neutral },
  // Оплачен и ждёт флориста. «Подтверждён» ничего не говорило: подтверждает заказ оплата.
  CONFIRMED: { label: "Оплачен", className: TONE.success },
  ASSIGNED: { label: "Принят", className: TONE.info },
  FLORIST_ACCEPTED: { label: "Принят", className: TONE.info },
  IN_PROGRESS: { label: "Начат", className: TONE.info },
  READY: { label: "Готов", className: TONE.success },
  AWAITING_COURIER: { label: "Ожидает курьера", className: TONE.info },
  IN_TRANSIT: { label: "В пути", className: TONE.info },
  DELIVERED: { label: "Доставлен", className: TONE.success },
  PROBLEM: { label: "Проблема", className: TONE.danger },
  CANCELLED: { label: "Отменён", className: TONE.neutral },
};

/**
 * Пункты фильтра по статусу — по одному на СМЫСЛ, а не на значение enum. ASSIGNED и
 * FLORIST_ACCEPTED схлопнуты в «Принят» (см. ACCEPTED_ORDER_STATUSES): иначе в списке два
 * одинаковых пункта, из которых один ничего не находит.
 */
export const orderStatusFilterOptions: { value: OrderStatus; label: string }[] = [
  { value: "AWAITING_PAYMENT", label: orderStatusMeta.AWAITING_PAYMENT.label },
  { value: "CONFIRMED", label: orderStatusMeta.CONFIRMED.label },
  { value: "FLORIST_ACCEPTED", label: orderStatusMeta.FLORIST_ACCEPTED.label }, // вся группа «принят»
  { value: "IN_PROGRESS", label: orderStatusMeta.IN_PROGRESS.label },
  { value: "READY", label: orderStatusMeta.READY.label },
  { value: "AWAITING_COURIER", label: orderStatusMeta.AWAITING_COURIER.label },
  { value: "IN_TRANSIT", label: orderStatusMeta.IN_TRANSIT.label },
  { value: "DELIVERED", label: orderStatusMeta.DELIVERED.label },
  { value: "PROBLEM", label: orderStatusMeta.PROBLEM.label },
  { value: "CANCELLED", label: orderStatusMeta.CANCELLED.label },
];

/** Значение для select фильтра: группа «принят» показывается одним пунктом FLORIST_ACCEPTED. */
export function statusFilterValue(status?: OrderStatus | null): string {
  if (!status) return "";
  return ACCEPTED_ORDER_STATUSES.includes(status) ? "FLORIST_ACCEPTED" : status;
}

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

// Метки статуса назначения не нужны: назначение автоматическое, отдельного «принятия» нет,
// а бейдж только дублировал статус заказа. AssignmentStatus остаётся в БД и в сериализации.

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
  "FLORIST_ACCEPTED",
  "IN_PROGRESS",
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED",
];
