import { describe, it, expect } from "vitest";
import { mapBurqStatus, isAutomationTerminal, orderStatusForDelivery, isDeliveredStatus } from "./statusMap";

describe("mapBurqStatus", () => {
  it("request → DRAFT_CREATED (черновик, не инициирован)", () => {
    expect(mapBurqStatus("request")).toBe("DRAFT_CREATED");
  });

  it("delivered → DELIVERED", () => {
    expect(mapBurqStatus("delivered")).toBe("DELIVERED");
  });

  it('"attempting reroute" → PROBLEM (нормализация пробела)', () => {
    expect(mapBurqStatus("attempting reroute")).toBe("PROBLEM");
    expect(mapBurqStatus("attempting-reroute")).toBe("PROBLEM");
    expect(mapBurqStatus("Attempting Reroute")).toBe("PROBLEM");
  });

  it("варианты отмены → CANCELLED", () => {
    expect(mapBurqStatus("provider_canceled")).toBe("CANCELLED");
    expect(mapBurqStatus("customer_canceled")).toBe("CANCELLED");
    expect(mapBurqStatus("burq_canceled")).toBe("CANCELLED");
  });

  it("неизвестный/пустой статус → UNKNOWN (без падения)", () => {
    expect(mapBurqStatus("something_new")).toBe("UNKNOWN");
    expect(mapBurqStatus(null)).toBe("UNKNOWN");
    expect(mapBurqStatus(undefined)).toBe("UNKNOWN");
    expect(mapBurqStatus("")).toBe("UNKNOWN");
  });
});

describe("isAutomationTerminal", () => {
  it("PROBLEM терминален для автоматики (не ждём авто-восстановления)", () => {
    expect(isAutomationTerminal("PROBLEM")).toBe(true);
  });
  it("DELIVERED/CANCELLED/FAILED/RETURNED терминальны", () => {
    for (const s of ["DELIVERED", "CANCELLED", "FAILED", "RETURNED"] as const) {
      expect(isAutomationTerminal(s)).toBe(true);
    }
  });
  it("промежуточные не терминальны", () => {
    expect(isAutomationTerminal("IN_TRANSIT")).toBe(false);
    expect(isAutomationTerminal("DRAFT_CREATED")).toBe(false);
  });
});

describe("orderStatusForDelivery", () => {
  it("черновик/планирование не меняют Order (null)", () => {
    expect(orderStatusForDelivery("DRAFT_CREATED")).toBeNull();
    expect(orderStatusForDelivery("SCHEDULED")).toBeNull();
  });
  it("в пути → IN_TRANSIT, доставлено → DELIVERED", () => {
    expect(orderStatusForDelivery("IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(orderStatusForDelivery("DELIVERED")).toBe("DELIVERED");
  });
  it("PROBLEM/FAILED/RETURNED/RETURNING → null (проблема доставки не меняет статус заказа)", () => {
    expect(orderStatusForDelivery("PROBLEM")).toBeNull();
    expect(orderStatusForDelivery("FAILED")).toBeNull();
    expect(orderStatusForDelivery("RETURNED")).toBeNull();
    expect(orderStatusForDelivery("RETURNING")).toBeNull();
  });
  it("отмена доставки не отменяет заказ (null)", () => {
    expect(orderStatusForDelivery("CANCELLED")).toBeNull();
  });
});

describe("isDeliveredStatus", () => {
  it("только DELIVERED публикует completed", () => {
    expect(isDeliveredStatus("DELIVERED")).toBe(true);
    expect(isDeliveredStatus("IN_TRANSIT")).toBe(false);
    expect(isDeliveredStatus("PROBLEM")).toBe(false);
  });
});
