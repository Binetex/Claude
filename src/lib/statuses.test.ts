import { describe, it, expect } from "vitest";
import { resolveOrderStatusMeta, orderStatusMeta } from "./statuses";

describe("resolveOrderStatusMeta — различие failed vs pending без миграции", () => {
  it("AWAITING_PAYMENT + paymentFailed → «Ошибка оплаты» (danger tone)", () => {
    const m = resolveOrderStatusMeta("AWAITING_PAYMENT", { paymentFailed: true });
    expect(m.label).toBe("Ошибка оплаты");
    expect(m.className).toContain("red");
  });

  it("AWAITING_PAYMENT без флага → «Ожидает оплаты» (обычный pending)", () => {
    const m = resolveOrderStatusMeta("AWAITING_PAYMENT", { paymentFailed: false });
    expect(m).toEqual(orderStatusMeta.AWAITING_PAYMENT);
    expect(m.label).toBe("Ожидает оплаты");
  });

  it("флаг игнорируется вне AWAITING_PAYMENT (напр. заказ восстановился в CONFIRMED)", () => {
    const m = resolveOrderStatusMeta("CONFIRMED", { paymentFailed: true });
    expect(m).toEqual(orderStatusMeta.CONFIRMED);
    expect(m.label).toBe("Подтверждён");
  });

  it("без opts работает как обычная карта статусов", () => {
    expect(resolveOrderStatusMeta("DELIVERED")).toEqual(orderStatusMeta.DELIVERED);
  });
});
