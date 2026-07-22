/**
 * Деривация внутреннего состояния заказа Floremart из WooCommerce-статуса + классификации
 * платежа, и правила anti-rollback. Чистые функции (без сети/БД) — тестируемы.
 *
 * Правила (подтверждены владельцем):
 *  - completed → DELIVERED, processing → CONFIRMED, cancelled → CANCELLED, refunded → CANCELLED+REFUNDED;
 *  - pending/on-hold обычного заказа → AWAITING_PAYMENT (флористу не отдаём);
 *  - pending BNPL, подтверждённый как PAY_LATER_APPROVED → CONFIRMED (можно в работу);
 *  - терминальные DELIVERED/CANCELLED/REFUNDED автоматически не откатываем;
 *  - внешние НЕтерминальные обновления не перезаписывают внутренние рабочие этапы
 *    (ASSIGNED/FLORIST_ACCEPTED/IN_PROGRESS/READY/AWAITING_COURIER/IN_TRANSIT);
 *  - уже подтверждённый PAID/PAY_LATER_APPROVED не откатывается generic pending-вебхуком.
 */
import type { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";
import type { WooPaymentResult } from "./payment";

export const INTERNAL_WORKING_STATUSES: OrderStatus[] = [
  "ASSIGNED",
  "FLORIST_ACCEPTED",
  "IN_PROGRESS",
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
];
const WORKING = new Set<OrderStatus>(INTERNAL_WORKING_STATUSES);
const TERMINAL = new Set<OrderStatus>(["DELIVERED", "CANCELLED"]);
const PAID_LIKE = new Set<PaymentStatus>(["PAID", "PAY_LATER_APPROVED"]);

export type OrderState = { orderStatus: OrderStatus; paymentStatus: PaymentStatus };

/** Является ли Woo-статус терминальным для внешней стороны (разрешает перекрыть внутренние этапы). */
export function isTerminalWooStatus(wooStatus: string): boolean {
  const s = wooStatus.toLowerCase();
  return s === "completed" || s === "cancelled" || s === "refunded";
}

/** Внешне-производное состояние (без учёта уже существующего локального состояния). */
export function deriveWooOrderState(wooStatus: string, payment: WooPaymentResult): OrderState {
  const s = (wooStatus ?? "").toLowerCase();
  switch (s) {
    case "completed":
      return { orderStatus: "DELIVERED", paymentStatus: "PAID" };
    case "processing":
      return { orderStatus: "CONFIRMED", paymentStatus: "PAID" };
    case "refunded":
      return { orderStatus: "CANCELLED", paymentStatus: "REFUNDED" };
    case "cancelled":
      return { orderStatus: "CANCELLED", paymentStatus: payment.paymentStatus };
    case "failed":
      return { orderStatus: "AWAITING_PAYMENT", paymentStatus: payment.paymentStatus };
    case "pending":
    case "on-hold":
    default:
      // BNPL-подтверждённый pending → рабочий CONFIRMED; иначе ожидание оплаты.
      return payment.workable
        ? { orderStatus: "CONFIRMED", paymentStatus: payment.paymentStatus }
        : { orderStatus: "AWAITING_PAYMENT", paymentStatus: payment.paymentStatus };
  }
}

/**
 * Сливает внешне-производное состояние с уже существующим локальным, применяя anti-rollback.
 * `wooStatus` нужен, чтобы понять, терминально ли внешнее событие (только терминальное вправе
 * перекрыть внутренние рабочие этапы).
 */
export function reconcileOrderState(existing: OrderState, incoming: OrderState, wooStatus: string): OrderState {
  const externalTerminal = isTerminalWooStatus(wooStatus);
  const wooLower = (wooStatus ?? "").toLowerCase();
  const incomingIsNegative = wooLower === "refunded" || wooLower === "failed" || wooLower === "cancelled";

  // 1) paymentStatus: не откатываем PAID/PAY_LATER_APPROVED к UNPAID из-за generic pending,
  //    если внешнее событие не является явным отказом/возвратом (failed/refunded/cancelled).
  let paymentStatus = incoming.paymentStatus;
  const paymentPreserved =
    PAID_LIKE.has(existing.paymentStatus) && incoming.paymentStatus === "UNPAID" && !incomingIsNegative;
  if (paymentPreserved) paymentStatus = existing.paymentStatus;

  // 2) orderStatus.
  let orderStatus = incoming.orderStatus;
  if (TERMINAL.has(existing.orderStatus) && !TERMINAL.has(incoming.orderStatus)) {
    // Не откатываем терминальный внутренний статус нетерминальным событием.
    orderStatus = existing.orderStatus;
  } else if (WORKING.has(existing.orderStatus) && !externalTerminal) {
    // Внутренний рабочий этап не перезаписываем нетерминальным внешним обновлением.
    orderStatus = existing.orderStatus;
  } else if (paymentPreserved && incoming.orderStatus === "AWAITING_PAYMENT" && existing.orderStatus !== "AWAITING_PAYMENT") {
    // Оплата сохранена как paid-like → не откатываем подтверждённый/рабочий заказ обратно
    // в «ожидает оплаты» из-за повторного generic pending-вебхука.
    orderStatus = existing.orderStatus;
  }

  return { orderStatus, paymentStatus };
}
