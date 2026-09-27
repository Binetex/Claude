import { describe, it, expect } from "vitest";
import { laterWindowFromWish, planReschedule, mentionsDay } from "./reschedule";
import { formatWindowText, type WindowRange } from "@/lib/deliveryWindow";

const MORNING: WindowRange = { from: 11 * 60, to: 15 * 60 };
const w = (r: WindowRange | null) => (r ? formatWindowText(r) : null);

describe("laterWindowFromWish — клиент перенёс с утра на после 15:00", () => {
  it("утреннее окно становится строгим «с — до» по словам клиента", () => {
    expect(w(laterWindowFromWish(MORNING, "after 5pm"))).toBe("17:00 - 21:00");
    expect(w(laterWindowFromWish(MORNING, "4-5pm today"))).toBe("16:00 - 17:00");
    expect(w(laterWindowFromWish({ from: 9 * 60, to: 15 * 60 }, "around 7 PM"))).toBe("18:30 - 19:30");
    // Время через точку — это время, а не дата.
    expect(w(laterWindowFromWish(MORNING, "after 3.30 pm"))).toBe("15:30 - 21:00");
  });

  it("не трогает: другой день, раннее время, «any time», окно и так не утреннее", () => {
    expect(laterWindowFromWish(MORNING, "tomorrow after 5")).toBeNull();
    expect(laterWindowFromWish(MORNING, "by noon")).toBeNull();
    expect(laterWindowFromWish(MORNING, "any time today")).toBeNull();
    expect(laterWindowFromWish(MORNING, "business closes at 6pm")).toBeNull();
    expect(laterWindowFromWish({ from: 15 * 60, to: 19 * 60 }, "after 6pm")).toBeNull();
    expect(laterWindowFromWish({ from: 690, to: 17 * 60 }, "after 4")).toBeNull();
    expect(laterWindowFromWish(null, "after 5pm")).toBeNull();
  });
});

describe("planReschedule — перенос по словам клиента", () => {
  const base = { todayStr: "2026-09-27", currentDay: "2026-09-27", currentWindow: MORNING };
  it("на завтра без времени — окно прежнее", () => {
    const p = planReschedule({ ...base, readyTime: null, newDate: "2026-09-28" });
    expect(p?.day).toBe("2026-09-28");
    expect(w(p!.window)).toBe("11:00 - 15:00");
  });
  it("на завтра после 5 — окно 17:00–21:00", () => {
    expect(w(planReschedule({ ...base, readyTime: "tomorrow after 5pm", newDate: "2026-09-28" })!.window)).toBe("17:00 - 21:00");
  });
  it("на завтра днём — слот 15:00–19:00", () => {
    expect(w(planReschedule({ ...base, readyTime: "tomorrow afternoon", newDate: "2026-09-28" })!.window)).toBe("15:00 - 19:00");
  });
  it("«any time» на новый день окно не трогает", () => {
    expect(w(planReschedule({ ...base, readyTime: "any time tomorrow", newDate: "2026-09-28" })!.window)).toBe("11:00 - 15:00");
  });
  it("раньше или тот же день, далёкая дата — не переносим", () => {
    expect(planReschedule({ ...base, currentDay: "2026-09-29", readyTime: null, newDate: "2026-09-28" })).toBeNull();
    expect(planReschedule({ ...base, readyTime: null, newDate: "2026-09-27" })).toBeNull();
    expect(planReschedule({ ...base, readyTime: null, newDate: "2026-12-01" })).toBeNull();
  });
  it("тот же день — только с утра на после 15:00", () => {
    const p = planReschedule({ ...base, readyTime: "after 5pm", newDate: null });
    expect(p?.day).toBe("2026-09-27");
    expect(w(p!.window)).toBe("17:00 - 21:00");
    expect(planReschedule({ ...base, readyTime: "by noon", newDate: null })).toBeNull();
  });
});

describe("mentionsDay — время через точку не дата", () => {
  it("день словами и дата через косую — да, «4.30» — нет", () => {
    expect(mentionsDay("can you come after 4.30?")).toBe(false);
    expect(mentionsDay("please deliver on 10/3")).toBe(true);
    expect(mentionsDay("tomorrow works better")).toBe(true);
  });
});
