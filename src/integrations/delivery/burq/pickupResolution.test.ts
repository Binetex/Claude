import { describe, it, expect } from "vitest";
import { resolvePickupForOrder, isOverrideEffective, type PickupCandidate } from "./pickupResolution";

const primary: PickupCandidate = { id: "pl_primary", floristId: "flo_1", isPrimary: true, isActive: true };
const second: PickupCandidate = { id: "pl_second", floristId: "flo_1", isPrimary: false, isActive: true };
const disabled: PickupCandidate = { id: "pl_off", floristId: "flo_1", isPrimary: false, isActive: false };

describe("resolvePickupForOrder", () => {
  it("без ручного выбора берёт основную активную точку", () => {
    const res = resolvePickupForOrder({ overrideId: null, floristPickups: [primary, second] });
    expect(res).toEqual({ location: primary, source: "FLORIST_PRIMARY" });
  });

  it("ручной выбор побеждает основную", () => {
    const res = resolvePickupForOrder({ overrideId: "pl_second", floristPickups: [primary, second] });
    expect(res).toEqual({ location: second, source: "ORDER_OVERRIDE" });
  });

  it("отключённый ручной выбор игнорируется — возвращаемся к основной", () => {
    const res = resolvePickupForOrder({ overrideId: "pl_off", floristPickups: [primary, disabled] });
    expect(res).toEqual({ location: primary, source: "FLORIST_PRIMARY" });
  });

  it("выбор точки ЧУЖОГО флориста игнорируется: после переназначения едем к новому флористу", () => {
    // Точки в списке — только назначенного флориста, поэтому чужой id просто не находится.
    const res = resolvePickupForOrder({ overrideId: "pl_of_another_florist", floristPickups: [primary] });
    expect(res).toEqual({ location: primary, source: "FLORIST_PRIMARY" });
  });

  it("основная отключена → null (заказ уходит в pickup_invalid, а не на запасную точку)", () => {
    const offPrimary: PickupCandidate = { ...primary, isActive: false };
    expect(resolvePickupForOrder({ overrideId: null, floristPickups: [offPrimary, second] })).toBeNull();
  });

  it("точек нет → null", () => {
    expect(resolvePickupForOrder({ overrideId: null, floristPickups: [] })).toBeNull();
  });

  it("isOverrideEffective отличает действующий ручной выбор от сохранённого, но неприменимого", () => {
    expect(isOverrideEffective({ overrideId: "pl_second", floristPickups: [primary, second] })).toBe(true);
    expect(isOverrideEffective({ overrideId: "pl_off", floristPickups: [primary, disabled] })).toBe(false);
  });
});
