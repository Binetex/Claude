import { describe, it, expect } from "vitest";
import { parseWindowText, formatWindowText, windowOf, windowFields, windowOptions, parseHm, fmtHm } from "./deliveryWindow";

const r = (raw: string) => {
  const w = parseWindowText(raw);
  return w && formatWindowText(w);
};

describe("parseWindowText — все окна, что были на проде за 60 дней", () => {
  it("окна магазинов — как есть", () => {
    expect(r("11:00 - 15:00")).toBe("11:00 - 15:00");
    expect(r("15:00 - 19:00")).toBe("15:00 - 19:00");
    expect(r("18:00 - 21:00")).toBe("18:00 - 21:00");
    expect(r("11:00 AM - 5:00 PM")).toBe("11:00 - 17:00");
    expect(r("4:00 PM - 7:00 PM")).toBe("16:00 - 19:00");
    expect(r("09:00 - 15:00")).toBe("09:00 - 15:00");
    expect(r("15:05 - 18:00")).toBe("15:05 - 18:00");
    expect(r("11:30 AM - 5:00 PM")).toBe("11:30 - 17:00");
    expect(r("5:00 PM - 8:30 PM")).toBe("17:00 - 20:30");
    expect(r("3:00 pm - 7:00 PM")).toBe("15:00 - 19:00");
    expect(r("11:00 AM - 8:00 PM")).toBe("11:00 - 20:00");
  });
  it("ручные записи", () => {
    expect(r("Before 3PM")).toBe("11:00 - 15:00");
    expect(r("до 12")).toBe("11:00 - 12:00");
    expect(r("until 3pm")).toBe("11:00 - 15:00");
    expect(r("before 5pm")).toBe("11:00 - 17:00");
    expect(r("до 5 вечера ")).toBe("11:00 - 17:00");
    expect(r("after 2pm")).toBe("14:00 - 21:00");
    expect(r("after 10am")).toBe("10:00 - 21:00");
    expect(r("после 5PM")).toBe("17:00 - 21:00");
    expect(r("С 6PM")).toBe("18:00 - 21:00");
    expect(r("5 - 5.30 PM")).toBe("17:00 - 17:30");
    expect(r("4.30 - 5pm")).toBe("16:30 - 17:00");
    expect(r("10.30-11.00 AM ")).toBe("10:30 - 11:00");
    expect(r("11:00 - 13:00")).toBe("11:00 - 13:00");
    expect(r("2pm")).toBe("13:30 - 14:30");
    expect(r("5.30 pm")).toBe("17:00 - 18:00");
    expect(r("3 PM")).toBe("14:30 - 15:30");
  });
  it("без часов — окна нет", () => {
    for (const raw of ["", "—", "желательно первым"]) expect(parseWindowText(raw), raw).toBeNull();
  });
});

describe("строгие поля главнее текста", () => {
  it("windowOf берёт числа, а без них — разбор текста", () => {
    expect(windowOf({ windowFrom: 900, windowTo: 1140, deliveryWindow: "11:00 - 15:00" })).toEqual({ from: 900, to: 1140 });
    expect(windowOf({ windowFrom: null, windowTo: null, deliveryWindow: "11:00 - 15:00" })).toEqual({ from: 660, to: 900 });
    expect(windowOf({ windowFrom: null, windowTo: null, deliveryWindow: "желательно первым" })).toBeNull();
  });
  it("windowFields пишет оба числа и текст одним форматом", () => {
    expect(windowFields({ from: 1020, to: 1260 })).toEqual({ windowFrom: 1020, windowTo: 1260, deliveryWindow: "17:00 - 21:00" });
    expect(windowFields(null)).toEqual({ windowFrom: null, windowTo: null, deliveryWindow: "" });
  });
  it("варианты времени — шаг 30 минут, текущее вне сетки не теряется", () => {
    const o = windowOptions([905]);
    expect(o).toContain(660);
    expect(o).toContain(690);
    expect(o).toContain(905);
    expect(o).not.toContain(675);
    expect(parseHm("14:30")).toBe(870);
    expect(fmtHm(870)).toBe("14:30");
    expect(parseHm("nope")).toBeNull();
  });
});
