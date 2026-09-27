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

import { piMetaFor } from "./deliveryPush";

describe("что уходит в заказ Woo", () => {
  it("окно словами приводится к слоту", () => {
    expect(piSlotFor("afternoon")?.slot).toBe("15:00 - 19:00");
    expect(piSlotFor("evening")?.slot).toBe("18:00 - 21:00");
    expect(piSlotFor("morning")?.slot).toBe("11:00 - 15:00");
    expect(piSlotFor("до 5 вечера ")?.slot).toBe("11:00 - 15:00");
  });
  it("окно без слота — дата всё равно уходит, слот не трогаем", () => {
    const r = piMetaFor("2026-09-28", "желательно первым");
    expect(r.slot).toBeNull();
    expect(r.meta.map((m) => m.key)).toEqual(["pi_system_delivery_date", "pi_delivery_date"]);
  });
  it("обычное окно — дата и слот", () => {
    expect(piMetaFor("2026-09-28", "after 5pm").meta.map((m) => m.key)).toEqual([
      "pi_system_delivery_date", "pi_delivery_date", "pi_delivery_time", "pi_display_delivery_time",
    ]);
  });
});
