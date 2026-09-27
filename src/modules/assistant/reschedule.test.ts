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

import { planReschedule } from "./reschedule";

describe("planReschedule — перенос по словам клиента", () => {
  const base = { todayStr: "2026-09-27", currentDay: "2026-09-27", currentWindow: "11:00 - 15:00" };
  it("на завтра без времени — окно прежнее", () => {
    expect(planReschedule({ ...base, readyTime: null, newDate: "2026-09-28" })).toEqual({ day: "2026-09-28", window: "11:00 - 15:00" });
  });
  it("на завтра после 5 — окно словами клиента", () => {
    expect(planReschedule({ ...base, readyTime: "tomorrow after 5pm", newDate: "2026-09-28" })).toEqual({ day: "2026-09-28", window: "after 5pm" });
  });
  it("«any time» на новый день окно не трогает", () => {
    expect(planReschedule({ ...base, readyTime: "any time tomorrow", newDate: "2026-09-28" })?.window).toBe("11:00 - 15:00");
  });
  it("раньше или тот же день, далёкая дата — не переносим", () => {
    expect(planReschedule({ ...base, currentDay: "2026-09-29", readyTime: null, newDate: "2026-09-28" })).toBeNull();
    expect(planReschedule({ ...base, readyTime: null, newDate: "2026-09-27" })).toBeNull();
    expect(planReschedule({ ...base, readyTime: null, newDate: "2026-12-01" })).toBeNull();
  });
  it("тот же день — только с утра на после 15:00", () => {
    expect(planReschedule({ ...base, readyTime: "after 5pm", newDate: null })).toEqual({ day: "2026-09-27", window: "after 5pm" });
    expect(planReschedule({ ...base, readyTime: "by noon", newDate: null })).toBeNull();
  });
});

import { mentionsDay } from "./reschedule";

describe("время через точку — не дата", () => {
  const base = { todayStr: "2026-09-27", currentDay: "2026-09-27", currentWindow: "11:00 - 15:00" };
  it("«after 3.30 pm» переносит окно в тот же день", () => {
    expect(planReschedule({ ...base, readyTime: "after 3.30 pm", newDate: null })).toEqual({ day: "2026-09-27", window: "after 3.30 pm" });
  });
  it("mentionsDay: время через точку — не день, дата через косую — день", () => {
    expect(mentionsDay("can you come after 4.30?")).toBe(false);
    expect(mentionsDay("please deliver on 10/3")).toBe(true);
    expect(mentionsDay("tomorrow works better")).toBe(true);
  });
});
