import { describe, it, expect } from "vitest";
import { decideDraftEligibility, type EligibilityInput } from "./eligibility";

const PICKUP = {
  locationName: "Main",
  contactName: "Jane",
  contactPhone: "+13105550198",
  addressLine: "1430 5th St",
  city: "Santa Monica",
  state: "CA",
  zip: "90401",
  isActive: true,
};

const base: EligibilityInput = {
  siteAutoCreateEnabled: true,
  orderStatus: "AWAITING_COURIER",
  floristId: "flo_1",
  pickup: PICKUP,
  hasCurrentDraft: false,
};

describe("decideDraftEligibility", () => {
  it("все условия ок → CREATE_DRAFT", () => {
    expect(decideDraftEligibility(base)).toEqual({ action: "CREATE_DRAFT" });
  });

  it("автосоздание выключено у сайта → SKIP site_disabled", () => {
    expect(decideDraftEligibility({ ...base, siteAutoCreateEnabled: false })).toEqual({
      action: "SKIP",
      reason: "site_disabled",
    });
  });

  it("draft уже есть → SKIP draft_exists", () => {
    expect(decideDraftEligibility({ ...base, hasCurrentDraft: true })).toEqual({
      action: "SKIP",
      reason: "draft_exists",
    });
  });

  it("терминальный заказ → SKIP order_terminal", () => {
    for (const s of ["DELIVERED", "CANCELLED", "REFUNDED", "PROBLEM"]) {
      expect(decideDraftEligibility({ ...base, orderStatus: s })).toEqual({
        action: "SKIP",
        reason: "order_terminal",
      });
    }
  });

  it("нет флориста → WAIT_FOR_FLORIST no_florist", () => {
    expect(decideDraftEligibility({ ...base, floristId: null })).toEqual({
      action: "WAIT_FOR_FLORIST",
      reason: "no_florist",
    });
  });

  it("pickup не настроен/невалиден → WAIT_FOR_FLORIST pickup_invalid", () => {
    expect(decideDraftEligibility({ ...base, pickup: null })).toEqual({
      action: "WAIT_FOR_FLORIST",
      reason: "pickup_invalid",
    });
    expect(decideDraftEligibility({ ...base, pickup: { ...PICKUP, state: "ZZ" } })).toEqual({
      action: "WAIT_FOR_FLORIST",
      reason: "pickup_invalid",
    });
  });

  it("приоритет: выключенный сайт важнее отсутствия флориста", () => {
    expect(
      decideDraftEligibility({ ...base, siteAutoCreateEnabled: false, floristId: null })
    ).toEqual({ action: "SKIP", reason: "site_disabled" });
  });
});
