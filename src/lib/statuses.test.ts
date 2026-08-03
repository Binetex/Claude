import { describe, it, expect } from "vitest";
import { resolveOrderStatusMeta, orderStatusMeta, orderStatusFilterOptions, statusFilterValue, ACCEPTED_ORDER_STATUSES, IN_WORK_ORDER_STATUSES, manualOrderStatuses } from "./statuses";

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

describe("«Принят» и «Начат» — два разных смысла у флориста", () => {
  it("ASSIGNED и FLORIST_ACCEPTED показываются одинаково («Принят»)", () => {
    const labels = ACCEPTED_ORDER_STATUSES.map((s) => orderStatusMeta[s].label);
    expect(new Set(labels)).toEqual(new Set(["Принят"]));
  });

  it("IN_PROGRESS — отдельный статус «Начат», а не синоним принятого", () => {
    expect(orderStatusMeta.IN_PROGRESS.label).toBe("Начат");
    expect(ACCEPTED_ORDER_STATUSES).not.toContain("IN_PROGRESS");
    // При этом обе стадии остаются «у флориста» — на этом держатся метрики.
    expect(IN_WORK_ORDER_STATUSES).toContain("IN_PROGRESS");
    expect(IN_WORK_ORDER_STATUSES).toEqual(expect.arrayContaining(ACCEPTED_ORDER_STATUSES));
  });

  it("фильтр предлагает один пункт на смысл, без дублей", () => {
    const labels = orderStatusFilterOptions.map((o) => o.label);
    expect(labels).toHaveLength(new Set(labels).size);
    const values = orderStatusFilterOptions.map((o) => o.value);
    // ASSIGNED отдельным пунктом не нужен — его покрывает «Принят» (FLORIST_ACCEPTED).
    expect(values).not.toContain("ASSIGNED");
    expect(values).toContain("FLORIST_ACCEPTED");
    expect(values).toContain("IN_PROGRESS");
  });

  it("ссылка ?status=ASSIGNED выбирает пункт «Принят», а не сбрасывается", () => {
    expect(statusFilterValue("ASSIGNED")).toBe("FLORIST_ACCEPTED");
    expect(statusFilterValue("FLORIST_ACCEPTED")).toBe("FLORIST_ACCEPTED");
    // «Начат» ни к чему не сводится — он сам себе смысл.
    expect(statusFilterValue("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(statusFilterValue("DELIVERED")).toBe("DELIVERED");
    expect(statusFilterValue(null)).toBe("");
  });

  /**
   * Оба смысла ставятся вручную: «Принят» — представителем группы (FLORIST_ACCEPTED),
   * «Начат» — самим IN_PROGRESS. Если убрать любой из них из выбираемых, заказ в этом
   * состоянии начнёт показывать в select чужой статус — тот самый баг, ради которого
   * и нужна нормализация в StatusForm.
   */
  it("представители обоих смыслов остаются выбираемыми вручную", () => {
    expect(manualOrderStatuses).toContain("FLORIST_ACCEPTED");
    expect(manualOrderStatuses).toContain("IN_PROGRESS");
  });

  it("статусы вне ручного выбора известны и не расширяются молча", () => {
    const notManual = (Object.keys(orderStatusMeta) as (keyof typeof orderStatusMeta)[]).filter(
      (s) => !manualOrderStatuses.includes(s)
    );
    // Их ставит система: оплата и легаси-назначение. Для них StatusForm рисует
    // отдельный нередактируемый пункт «(текущий)».
    expect(new Set(notManual)).toEqual(new Set(["AWAITING_PAYMENT", "ASSIGNED"]));
  });
});
