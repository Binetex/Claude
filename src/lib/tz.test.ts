import { describe, it, expect } from "vitest";
import { localDateStr } from "@/lib/tz";

describe("localDateStr — «сегодня» по таймзоне магазина", () => {
  it("возвращает дату в указанной таймзоне, не в UTC", () => {
    // 05:00 UTC = 22:00 предыдущего дня в Лос-Анджелесе (UTC-7 летом).
    const d = new Date("2026-07-17T05:00:00Z");
    expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-07-16");
    expect(localDateStr(d, "UTC")).toBe("2026-07-17");
  });
});
