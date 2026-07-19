import { describe, it, expect } from "vitest";
import { buildDeliveryPanelView, burqDashboardModeHint, BURQ_DASHBOARD_ORDERS_URL, BURQ_FIND_BY_NAME_TEXT } from "./dashboardHint";

describe("Burq dashboard UX — модель панели флориста", () => {
  it("кнопка ведёт на список заказов Burq (без per-order URL)", () => {
    expect(BURQ_DASHBOARD_ORDERS_URL).toBe("https://app.burqup.com/v1/orders");
  });

  it("подсказка режима: Test для SANDBOX, Live для PRODUCTION", () => {
    expect(burqDashboardModeHint("SANDBOX")).toBe("Перед поиском включите Test mode в Burq.");
    expect(burqDashboardModeHint("PRODUCTION")).toBe("Перед поиском включите Live mode в Burq.");
  });

  it("текст поиска — по имени получателя", () => {
    expect(BURQ_FIND_BY_NAME_TEXT).toBe("Найдите заказ в Burq по имени получателя.");
  });

  it("модель несёт имя получателя (dropoff.name = Order.recipientName) и Dashboard-кнопку", () => {
    const v = buildDeliveryPanelView({
      delivery: { status: "DRAFT_CREATED", externalDeliveryId: "o_burq_123" },
      recipientName: "Jessica Miller",
      environment: "SANDBOX",
    });
    expect(v.hasDelivery).toBe(true);
    expect(v.recipientName).toBe("Jessica Miller");
    expect(v.dashboardUrl).toBe("https://app.burqup.com/v1/orders");
    expect(v.findByNameText).toBe(BURQ_FIND_BY_NAME_TEXT);
    expect(v.modeHint).toContain("Test mode");
  });

  it("НЕ содержит External Order ID / checkout_url как поля действия", () => {
    const v = buildDeliveryPanelView({ delivery: { status: "DRAFT_CREATED", externalDeliveryId: "o_1" }, recipientName: "R", environment: "SANDBOX" });
    const keys = Object.keys(v);
    expect(keys).not.toContain("externalOrderRef");
    expect(keys).not.toContain("checkoutUrl");
    expect(keys).not.toContain("copyText");
    // Burq Order ID присутствует ТОЛЬКО как служебный диагностический текст.
    expect(v.orderIdDiagnostic).toBe("o_1");
  });

  it("отсутствие checkout_url не ломает модель (её там нет); нет доставки → hasDelivery=false", () => {
    const v = buildDeliveryPanelView({ delivery: null, recipientName: "R", environment: "PRODUCTION" });
    expect(v.hasDelivery).toBe(false);
    expect(v.orderIdDiagnostic).toBeNull();
    expect(v.recipientName).toBe("R");
    expect(v.modeHint).toContain("Live mode");
  });
});
