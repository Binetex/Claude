import { describe, it, expect } from "vitest";
import { laterWindowFromWish } from "./reschedule";

describe("laterWindowFromWish — клиент перенёс с утра на после 15:00", () => {
  it("меняет утреннее окно на слова клиента", () => {
    expect(laterWindowFromWish("11:00 - 15:00", "after 5pm")).toBe("after 5pm");
    expect(laterWindowFromWish("11:00 - 15:00", "4-5pm today")).toBe("4-5pm");
    expect(laterWindowFromWish("09:00 - 15:00", "around 7 PM")).toBe("around 7 PM");
  });

  it("не трогает: другой день, раннее время, «any time», окно и так не утреннее", () => {
    expect(laterWindowFromWish("11:00 - 15:00", "tomorrow after 5")).toBeNull();
    expect(laterWindowFromWish("11:00 - 15:00", "by noon")).toBeNull();
    expect(laterWindowFromWish("11:00 - 15:00", "any time today")).toBeNull();
    expect(laterWindowFromWish("11:00 - 15:00", "business closes at 6pm")).toBeNull();
    expect(laterWindowFromWish("15:00 - 19:00", "after 6pm")).toBeNull();
    expect(laterWindowFromWish("11:30 AM - 5:00 PM", "after 4")).toBeNull();
  });
});
