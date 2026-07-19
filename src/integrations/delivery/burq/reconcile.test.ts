import { describe, it, expect } from "vitest";
import { shouldApplyDeliveryUpdate } from "./reconcile";

const T = (iso: string) => new Date(iso);

describe("shouldApplyDeliveryUpdate — anti-rollback", () => {
  it("применяет обычное свежее событие", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "IN_TRANSIT", providerEventAt: T("2026-07-18T10:00:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z") }
    );
    expect(r.apply).toBe(true);
  });

  it("stale-event: старое событие не применяется", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "IN_TRANSIT", providerEventAt: T("2026-07-18T10:00:00Z") }
    );
    expect(r.apply).toBe(false);
    // Терминальный DELIVERED сработает раньше или stale — оба валидны как «не применять».
  });

  it("hard-terminal DELIVERED не откатывается в PROBLEM (attempting reroute) поздним webhook", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "PROBLEM", providerEventAt: T("2026-07-18T11:00:00Z") }
    );
    expect(r.apply).toBe(false);
    expect(r.reason).toBe("terminal_no_rollback");
  });

  it("PROBLEM (attempting reroute) → официальный delivered разрешён, если ручного решения не было", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "PROBLEM", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "DELIVERED", providerEventAt: T("2026-07-18T11:00:00Z") }
    );
    expect(r.apply).toBe(true);
  });

  it("manual-lock: ручное DELIVERED не перебивается поздним webhook", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "MANUAL_ADMIN" },
      { status: "PROBLEM", providerEventAt: T("2026-07-18T12:00:00Z") }
    );
    expect(r.apply).toBe(false);
    expect(r.reason).toBe("manual_decision_locked");
  });

  it("manual-lock: ручное CANCELLED не перебивается", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "CANCELLED", providerEventAt: null, resolutionSource: "MANUAL_ADMIN" },
      { status: "DELIVERED", providerEventAt: T("2026-07-18T12:00:00Z") }
    );
    expect(r.apply).toBe(false);
  });

  it("ручное действие сотрудника проходит всегда", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "PROBLEM", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "CANCELLED", providerEventAt: null, manual: true }
    );
    expect(r.apply).toBe(true);
    expect(r.reason).toBe("manual_action");
  });

  it("одинаковый терминальный статус (повтор) не считается откатом", () => {
    const r = shouldApplyDeliveryUpdate(
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z"), resolutionSource: "BURQ_WEBHOOK" },
      { status: "DELIVERED", providerEventAt: T("2026-07-18T10:30:00Z") }
    );
    expect(r.apply).toBe(true);
  });
});
