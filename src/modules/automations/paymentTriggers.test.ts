/**
 * Сопоставление состояния оплаты с триггером. Границы согласованы с владельцем:
 * pending — только BNPL, возврат — только полный, обычная неоплата триггер не запускает.
 */
import { describe, it, expect } from "vitest";
import { paymentTriggerFor } from "./paymentTriggers";

describe("paymentTriggerFor", () => {
  it("BNPL в ожидании подтверждения → PAYMENT_PENDING", () => {
    expect(paymentTriggerFor({ classification: "PAYMENT_PENDING", payLater: true }, "UNPAID")).toBe("PAYMENT_PENDING");
  });

  it("обычный неоплаченный заказ триггер НЕ запускает", () => {
    // У Woo это тот же PAYMENT_PENDING, но без BNPL писать клиенту не о чем.
    expect(paymentTriggerFor({ classification: "PAYMENT_PENDING", payLater: false }, "UNPAID")).toBeNull();
  });

  it("отказ оплаты → PAYMENT_FAILED", () => {
    expect(paymentTriggerFor({ classification: "PAYMENT_FAILED", payLater: true }, "UNPAID")).toBe("PAYMENT_FAILED");
    expect(paymentTriggerFor({ classification: "PAYMENT_FAILED", payLater: false }, "UNPAID")).toBe("PAYMENT_FAILED");
  });

  it("полный возврат → ORDER_REFUNDED", () => {
    expect(paymentTriggerFor({ classification: "REFUNDED" }, "REFUNDED")).toBe("ORDER_REFUNDED");
  });

  it("ЧАСТИЧНЫЙ возврат триггер НЕ запускает", () => {
    expect(paymentTriggerFor({ classification: "PAID" }, "PARTIALLY_REFUNDED")).toBeNull();
  });

  it("оплаченный заказ — никакого триггера", () => {
    expect(paymentTriggerFor({ classification: "PAID" }, "PAID")).toBeNull();
    expect(paymentTriggerFor({ classification: "PAY_LATER_APPROVED", payLater: true }, "PAY_LATER_APPROVED")).toBeNull();
  });

  it("без классификации (Shopify / старые заказы) — только полный возврат по paymentStatus", () => {
    expect(paymentTriggerFor({ classification: null }, "UNPAID")).toBeNull();
    expect(paymentTriggerFor({ classification: null }, "REFUNDED")).toBe("ORDER_REFUNDED");
  });

  it("UNKNOWN у BNPL не считается ожиданием — не гадаем", () => {
    expect(paymentTriggerFor({ classification: "UNKNOWN", payLater: true }, "UNPAID")).toBeNull();
  });
});
