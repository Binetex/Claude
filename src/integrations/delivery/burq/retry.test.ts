import { describe, it, expect } from "vitest";
import { canRetryDelivery } from "./retryService";

describe("canRetryDelivery — видимость кнопки повторной доставки", () => {
  it("текущая попытка CANCELLED/FAILED/PROBLEM/RETURNED + заказ активен → true", () => {
    for (const s of ["CANCELLED", "FAILED", "PROBLEM", "RETURNED"]) {
      expect(canRetryDelivery(s, "AWAITING_COURIER")).toBe(true);
      expect(canRetryDelivery(s, "ASSIGNED")).toBe(true);
    }
  });

  it("активная (не терминальная) попытка → false", () => {
    expect(canRetryDelivery("DRAFT_CREATED", "AWAITING_COURIER")).toBe(false);
    expect(canRetryDelivery("IN_TRANSIT", "IN_TRANSIT")).toBe(false);
    expect(canRetryDelivery("DELIVERED", "DELIVERED")).toBe(false);
  });

  it("заказ DELIVERED или CANCELLED → false (даже если попытка отменена)", () => {
    expect(canRetryDelivery("CANCELLED", "DELIVERED")).toBe(false);
    expect(canRetryDelivery("CANCELLED", "CANCELLED")).toBe(false);
    expect(canRetryDelivery("FAILED", "DELIVERED")).toBe(false);
  });

  it("нет текущей попытки → false", () => {
    expect(canRetryDelivery(null, "AWAITING_COURIER")).toBe(false);
  });
});
