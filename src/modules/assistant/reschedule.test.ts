import { describe, it, expect } from "vitest";
import { planReschedule, confirmedWindow, mentionsDay, laterOnly } from "./reschedule";
import { formatWindowText, type WindowRange } from "@/lib/deliveryWindow";

const h = (hh: number, mm = 0) => hh * 60 + mm;
const MORNING: WindowRange = { from: h(11), to: h(15) };
const w = (r: WindowRange | null | undefined) => (r ? formatWindowText(r) : null);
const none = { from: null, until: null };

describe("confirmedWindow — окно по тому, что ответ пообещал", () => {
  it("«после 5» — с 17:00 до 21:00", () => {
    expect(w(confirmedWindow(MORNING, { from: h(17), until: null }))).toBe("17:00 - 21:00");
  });
  it("«до 1:40» — с прежнего начала окна до 13:40", () => {
    expect(w(confirmedWindow({ from: h(11), to: h(19) }, { from: null, until: h(13, 40) }))).toBe("11:00 - 13:40");
  });
  it("«до 4», а окно начиналось позже — с 11:00; раннее «до 10» — за час до конца", () => {
    expect(w(confirmedWindow({ from: h(17), to: h(21) }, { from: null, until: h(16) }))).toBe("11:00 - 16:00");
    expect(w(confirmedWindow(null, { from: null, until: h(10) }))).toBe("09:00 - 10:00");
  });
  it("«около 9 утра» заранее — как обещано", () => {
    expect(w(confirmedWindow(MORNING, { from: h(9), until: h(9, 30) }))).toBe("09:00 - 09:30");
  });
  it("ничего не обещано или «с» после 21:00 — окна нет", () => {
    expect(confirmedWindow(MORNING, none)).toBeNull();
    expect(confirmedWindow(MORNING, { from: h(21, 30), until: null })).toBeNull();
  });
});

describe("planReschedule — перенос по обещанному", () => {
  const base = { todayStr: "2026-09-27", currentDay: "2026-09-27", currentWindow: MORNING };
  it("на завтра без времени — окно прежнее", () => {
    const p = planReschedule({ ...base, confirmed: none, newDate: "2026-09-28" });
    expect(p?.day).toBe("2026-09-28");
    expect(w(p!.window)).toBe("11:00 - 15:00");
  });
  it("на завтра после 5 — окно 17:00–21:00", () => {
    expect(w(planReschedule({ ...base, confirmed: { from: h(17), until: null }, newDate: "2026-09-28" })!.window)).toBe("17:00 - 21:00");
  });
  it("раньше или тот же день, далёкая дата — не переносим", () => {
    expect(planReschedule({ ...base, currentDay: "2026-09-29", confirmed: none, newDate: "2026-09-28" })).toBeNull();
    expect(planReschedule({ ...base, confirmed: none, newDate: "2026-09-27" })).toBeNull();
    expect(planReschedule({ ...base, confirmed: none, newDate: "2026-12-01" })).toBeNull();
  });
  it("тот же день — обещанное окно; ничего не обещано — не трогаем", () => {
    const p = planReschedule({ ...base, confirmed: { from: null, until: h(16) }, newDate: null });
    expect(p?.day).toBe("2026-09-27");
    expect(w(p!.window)).toBe("11:00 - 16:00");
    expect(planReschedule({ ...base, confirmed: none, newDate: null })).toBeNull();
  });
});

describe("окно по словам клиента — только позже (владелец 30.09.2026: «это в угоду новым заказам»)", () => {
  const DAY: WindowRange = { from: h(15), to: h(19) };
  const base = { todayStr: "2026-09-30", currentDay: "2026-09-30", currentWindow: DAY, newDate: null };
  it("«до 4» при окне 3–7 — пожелание: окно не ужимаем", () => {
    expect(w(planReschedule({ ...base, confirmed: { from: null, until: h(16) } })!.window)).toBe("15:00 - 19:00");
  });
  it("«около 4» при окне 3–7 — только начало позже, конец прежний", () => {
    expect(w(planReschedule({ ...base, confirmed: { from: h(16), until: h(17) } })!.window)).toBe("16:00 - 19:00");
  });
  it("«после 8» — позже целиком", () => {
    expect(w(planReschedule({ ...base, confirmed: { from: h(20), until: null } })!.window)).toBe("20:00 - 21:00");
  });
  it("«завтра с 10 до 12» при окне 11–17 — день новый, окно согласованное", () => {
    const p = planReschedule({ todayStr: "2026-09-29", currentDay: "2026-09-29", currentWindow: { from: h(11), to: h(17) }, confirmed: { from: h(10), until: h(12) }, newDate: "2026-09-30" });
    expect(p?.day).toBe("2026-09-30");
    expect(w(p!.window)).toBe("11:00 - 17:00");
  });
  it("окна не было — берём названное", () => {
    expect(w(laterOnly(null, { from: h(10), to: h(12) }))).toBe("10:00 - 12:00");
  });
});

describe("mentionsDay — время через точку не дата", () => {
  it("день словами и дата через косую — да, «4.30» — нет", () => {
    expect(mentionsDay("can you come after 4.30?")).toBe(false);
    expect(mentionsDay("please deliver on 10/3")).toBe(true);
    expect(mentionsDay("tomorrow works better")).toBe(true);
  });
});
