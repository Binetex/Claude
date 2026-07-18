import { describe, it, expect } from "vitest";
import { classifyWooPayment, type WooPaymentConfig, type WooOrderForPayment } from "./payment";

// Базовый конфиг: Airwallex включён, метод "airwallex_klarna" — BNPL; meta-ключ статуса задан.
const cfg = (over: Partial<WooPaymentConfig> = {}): WooPaymentConfig => ({
  airwallexEnabled: true,
  klarnaPayLaterPendingIsConfirmed: false,
  airwallexPaymentMethodIds: ["airwallex_klarna"],
  airwallexMetaKeys: { paymentIntentStatusKey: "_airwallex_payment_status" },
  payLaterMaxWaitMinutes: 1440,
  unknownBehavior: "HOLD",
  ...over,
});

const order = (o: Partial<WooOrderForPayment>): WooOrderForPayment => ({ status: "pending", ...o });

describe("classifyWooPayment — Airwallex/Klarna BNPL", () => {
  it("1) обычный pending без доказательств оплаты → PAYMENT_PENDING, флористу не отдаём", () => {
    const r = classifyWooPayment(order({ status: "pending", payment_method: "bacs" }), cfg());
    expect(r.classification).toBe("PAYMENT_PENDING");
    expect(r.paymentStatus).toBe("UNPAID");
    expect(r.workable).toBe(false);
  });

  it("2) Airwallex Klarna Pay Later с подтверждающей meta → PAY_LATER_APPROVED, workable", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "AUTHORIZED" }] }),
      cfg()
    );
    expect(r.classification).toBe("PAY_LATER_APPROVED");
    expect(r.paymentStatus).toBe("PAY_LATER_APPROVED");
    expect(r.workable).toBe(true);
  });

  it("3) Klarna только в title без подтверждения → PAYMENT_PENDING (title НЕ признак)", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "bacs", payment_method_title: "Klarna Pay Later" }),
      cfg()
    );
    expect(r.classification).toBe("PAYMENT_PENDING");
    expect(r.workable).toBe(false);
  });

  it("4) Airwallex pending → success: SUCCEEDED в meta → PAY_LATER_APPROVED", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "SUCCEEDED" }] }),
      cfg()
    );
    expect(r.classification).toBe("PAY_LATER_APPROVED");
    expect(r.workable).toBe(true);
  });

  it("5) Airwallex failed-статус в meta → PAYMENT_FAILED, не workable", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "DECLINED" }] }),
      cfg()
    );
    expect(r.classification).toBe("PAYMENT_FAILED");
    expect(r.workable).toBe(false);
  });

  it("6) BNPL без явной meta, но с transaction_id → PAY_LATER_APPROVED (косвенно, с предупреждением)", () => {
    const r = classifyWooPayment(order({ status: "pending", payment_method: "airwallex_klarna", transaction_id: "int_123" }), cfg());
    expect(r.classification).toBe("PAY_LATER_APPROVED");
    expect(r.workable).toBe(true);
    expect(r.warning).toBeTruthy();
  });

  it("7) BNPL pending без доказательств, флаг klarnaPayLaterPendingIsConfirmed=false → PAYMENT_PENDING+warning", () => {
    const r = classifyWooPayment(order({ status: "pending", payment_method: "airwallex_klarna" }), cfg());
    expect(r.classification).toBe("PAYMENT_PENDING");
    expect(r.workable).toBe(false);
    expect(r.warning).toBeTruthy();
  });

  it("7b) тот же случай, но owner доверяет pending BNPL → PAY_LATER_APPROVED", () => {
    const r = classifyWooPayment(order({ status: "pending", payment_method: "airwallex_klarna" }), cfg({ klarnaPayLaterPendingIsConfirmed: true }));
    expect(r.classification).toBe("PAY_LATER_APPROVED");
    expect(r.workable).toBe(true);
  });

  it("8) неизвестное значение статуса → UNKNOWN, флористу НЕ отдаём", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "SOMETHING_NEW" }] }),
      cfg()
    );
    expect(r.classification).toBe("UNKNOWN");
    expect(r.workable).toBe(false);
    expect(r.warning).toBeTruthy();
  });

  it("refund → REFUNDED; processing/completed → PAID", () => {
    expect(classifyWooPayment(order({ status: "refunded" }), cfg()).classification).toBe("REFUNDED");
    expect(classifyWooPayment(order({ status: "processing" }), cfg()).paymentStatus).toBe("PAID");
    expect(classifyWooPayment(order({ status: "completed" }), cfg()).paymentStatus).toBe("PAID");
  });

  it("Airwallex выключен → BNPL-эвристики не применяются, pending остаётся PAYMENT_PENDING", () => {
    const r = classifyWooPayment(
      order({ status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "AUTHORIZED" }] }),
      cfg({ airwallexEnabled: false })
    );
    expect(r.classification).toBe("PAYMENT_PENDING");
  });
});
