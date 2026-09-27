import { describe, it, expect } from "vitest";
import { piSlotFor, piDates } from "./deliveryPush";

describe("перенос в поля плагина доставки", () => {
  it("окно приводится к слоту плагина по началу", () => {
    expect(piSlotFor("11:00 - 15:00")?.slot).toBe("11:00 - 15:00");
    expect(piSlotFor("15:00-19:00")?.slot).toBe("15:00 - 19:00");
    expect(piSlotFor("after 5pm")?.slot).toBe("15:00 - 19:00");
    expect(piSlotFor("4.30 - 5pm")?.slot).toBe("15:00 - 19:00");
    expect(piSlotFor("around 7 PM")?.slot).toBe("18:00 - 21:00");
    expect(piSlotFor("2pm")?.slot).toBe("11:00 - 15:00");
    expect(piSlotFor("before 5pm")?.slot).toBe("11:00 - 15:00");
    expect(piSlotFor("желательно первым")).toBeNull();
  });

  it("даты в формате плагина", () => {
    expect(piDates("2026-09-28")).toEqual({ system: "2026/09/28", display: "September 28, 2026" });
  });
});
