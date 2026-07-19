import { describe, it, expect } from "vitest";
import { zonedLocalTimeToUtc } from "./tz";

describe("zonedLocalTimeToUtc", () => {
  it("04:00 LA (PDT, летом UTC−7) → 11:00Z того же дня", () => {
    const utc = zonedLocalTimeToUtc("2026-07-18", "04:00", "America/Los_Angeles");
    expect(utc.toISOString()).toBe("2026-07-18T11:00:00.000Z");
  });

  it("зимой LA (PST, UTC−8): 04:00 → 12:00Z", () => {
    const utc = zonedLocalTimeToUtc("2026-01-15", "04:00", "America/Los_Angeles");
    expect(utc.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("граница суток: локальное раннее утро → тот же UTC-день (не следующий)", () => {
    // 04:00 LA — в UTC это 11:00/12:00 того же дня, а не следующего.
    const utc = zonedLocalTimeToUtc("2026-07-18", "04:00", "America/Los_Angeles");
    expect(utc.getUTCDate()).toBe(18);
  });

  it("null tz → дефолт America/Los_Angeles", () => {
    const a = zonedLocalTimeToUtc("2026-07-18", "04:00", null);
    const b = zonedLocalTimeToUtc("2026-07-18", "04:00", "America/Los_Angeles");
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("UTC-зона: настенное время == UTC", () => {
    const utc = zonedLocalTimeToUtc("2026-07-18", "04:00", "UTC");
    expect(utc.toISOString()).toBe("2026-07-18T04:00:00.000Z");
  });
});
