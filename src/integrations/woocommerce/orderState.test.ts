import { describe, it, expect } from "vitest";
import { deriveWooOrderState, reconcileOrderState, type OrderState } from "./orderState";
import type { WooPaymentResult } from "./payment";

const pay = (over: Partial<WooPaymentResult> = {}): WooPaymentResult => ({
  classification: "PAYMENT_PENDING",
  paymentStatus: "UNPAID",
  workable: false,
  warning: null,
  payLater: false,
  ...over,
});

describe("deriveWooOrderState — маппинг статусов (сценарии 12–16)", () => {
  it("pending → AWAITING_PAYMENT (12)", () => {
    expect(deriveWooOrderState("pending", pay())).toEqual({ orderStatus: "AWAITING_PAYMENT", paymentStatus: "UNPAID" });
  });
  it("on-hold → AWAITING_PAYMENT (не подтверждён)", () => {
    expect(deriveWooOrderState("on-hold", pay())).toEqual({ orderStatus: "AWAITING_PAYMENT", paymentStatus: "UNPAID" });
  });
  it("cancelled → CANCELLED (13)", () => {
    expect(deriveWooOrderState("cancelled", pay()).orderStatus).toBe("CANCELLED");
  });
  it("refunded → CANCELLED + REFUNDED (14)", () => {
    expect(deriveWooOrderState("refunded", pay())).toEqual({ orderStatus: "CANCELLED", paymentStatus: "REFUNDED" });
  });
  it("processing → CONFIRMED + PAID", () => {
    expect(deriveWooOrderState("processing", pay())).toEqual({ orderStatus: "CONFIRMED", paymentStatus: "PAID" });
  });
  it("completed → DELIVERED + PAID (16)", () => {
    expect(deriveWooOrderState("completed", pay())).toEqual({ orderStatus: "DELIVERED", paymentStatus: "PAID" });
  });
  it("pending + BNPL workable → CONFIRMED + PAY_LATER_APPROVED", () => {
    expect(deriveWooOrderState("pending", pay({ workable: true, paymentStatus: "PAY_LATER_APPROVED" }))).toEqual({
      orderStatus: "CONFIRMED",
      paymentStatus: "PAY_LATER_APPROVED",
    });
  });
});

describe("reconcileOrderState — anti-rollback", () => {
  it("15) внутренний IN_PROGRESS не перезаписывается processing (нетерминальным)", () => {
    const existing: OrderState = { orderStatus: "IN_PROGRESS", paymentStatus: "PAID" };
    const incoming: OrderState = { orderStatus: "CONFIRMED", paymentStatus: "PAID" }; // processing
    expect(reconcileOrderState(existing, incoming, "processing").orderStatus).toBe("IN_PROGRESS");
  });

  it("рабочий этап ПЕРЕКРЫВАЕТСЯ терминальным cancelled/completed", () => {
    const existing: OrderState = { orderStatus: "IN_PROGRESS", paymentStatus: "PAID" };
    expect(reconcileOrderState(existing, { orderStatus: "CANCELLED", paymentStatus: "UNPAID" }, "cancelled").orderStatus).toBe("CANCELLED");
    expect(reconcileOrderState(existing, { orderStatus: "DELIVERED", paymentStatus: "PAID" }, "completed").orderStatus).toBe("DELIVERED");
  });

  it("терминальный DELIVERED/CANCELLED не откатывается нетерминальным событием", () => {
    const delivered: OrderState = { orderStatus: "DELIVERED", paymentStatus: "PAID" };
    expect(reconcileOrderState(delivered, { orderStatus: "CONFIRMED", paymentStatus: "PAID" }, "processing").orderStatus).toBe("DELIVERED");
  });

  it("6-Airwallex) уже PAY_LATER_APPROVED не откатывается generic pending-вебхуком", () => {
    const approved: OrderState = { orderStatus: "CONFIRMED", paymentStatus: "PAY_LATER_APPROVED" };
    const incoming: OrderState = { orderStatus: "AWAITING_PAYMENT", paymentStatus: "UNPAID" }; // generic pending
    const r = reconcileOrderState(approved, incoming, "pending");
    expect(r.paymentStatus).toBe("PAY_LATER_APPROVED"); // оплата не откатилась
    expect(r.orderStatus).toBe("CONFIRMED"); // рабочее состояние сохранено
  });

  it("PAID не откатывается pending, но failed/refunded — откатывают оплату", () => {
    const paid: OrderState = { orderStatus: "CONFIRMED", paymentStatus: "PAID" };
    expect(reconcileOrderState(paid, { orderStatus: "AWAITING_PAYMENT", paymentStatus: "UNPAID" }, "failed").paymentStatus).toBe("UNPAID");
    expect(reconcileOrderState(paid, { orderStatus: "CANCELLED", paymentStatus: "REFUNDED" }, "refunded").paymentStatus).toBe("REFUNDED");
  });
});
