import { describe, it, expect } from "vitest";
import { deliveryCostKnown } from "./financeMissing";

describe("deliveryCostKnown — одно правило на расчёт и карточку", () => {
  it("подтверждённый ноль и сумма от Burq известны, неподтверждённый ноль — нет", () => {
    expect(deliveryCostKnown(0, "2026-09-05T00:00:00Z")).toBe(true);
    expect(deliveryCostKnown(1049, null)).toBe(true);
    expect(deliveryCostKnown(0, null)).toBe(false);
  });
});
