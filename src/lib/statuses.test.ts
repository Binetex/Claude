import { describe, it, expect } from "vitest";
import { resolveOrderStatusMeta, orderStatusMeta, orderStatusFilterOptions, statusFilterValue, IN_WORK_ORDER_STATUSES } from "./statuses";

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
    expect(m.label).toBe("Оплачен");
  });

  it("без opts работает как обычная карта статусов", () => {
    expect(resolveOrderStatusMeta("DELIVERED")).toEqual(orderStatusMeta.DELIVERED);
  });
});

describe("группа «в работе» — один статус вместо трёх", () => {
  it("ASSIGNED, FLORIST_ACCEPTED и IN_PROGRESS показываются одинаково", () => {
    const labels = IN_WORK_ORDER_STATUSES.map((s) => orderStatusMeta[s].label);
    expect(new Set(labels)).toEqual(new Set(["В работе"]));
  });

  it("фильтр предлагает один пункт на смысл, без дублей", () => {
    const labels = orderStatusFilterOptions.map((o) => o.label);
    expect(labels).toHaveLength(new Set(labels).size);
    // Ни ASSIGNED, ни FLORIST_ACCEPTED в списке нет — их покрывает пункт IN_PROGRESS.
    expect(orderStatusFilterOptions.map((o) => o.value)).not.toContain("FLORIST_ACCEPTED");
  });

  it("старая ссылка ?status=FLORIST_ACCEPTED выбирает пункт «В работе», а не сбрасывается", () => {
    expect(statusFilterValue("FLORIST_ACCEPTED")).toBe("IN_PROGRESS");
    expect(statusFilterValue("ASSIGNED")).toBe("IN_PROGRESS");
    expect(statusFilterValue("DELIVERED")).toBe("DELIVERED");
    expect(statusFilterValue(null)).toBe("");
  });
});
