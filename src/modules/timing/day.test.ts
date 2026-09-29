import { describe, it, expect } from "vitest";
import { isBigOrder, readyTimeWishes, clockLabelEn, fmtDuration, withClosure, sameDayFallback, isPriorityShop, asClosureLevel } from "./day";

describe("помощники времени", () => {
  it("большой букет — от $250", () => {
    expect(isBigOrder([{ price: 195 }])).toBe(false);
    expect(isBigOrder([{ price: 250 }])).toBe(true);
    // Реальный заказ 22.09: $305 + $185 + ваза.
    expect(isBigOrder([{ price: 305 }, { price: 185 }, { price: 25 }])).toBe(true);
  });

  it("пожелания из заметки — свежие сверху", () => {
    const note = "23.09, 08:04 · Клиент (SMS): готов принять 6 PM\n———\n19.09, 10:39 · Клиент (SMS): готов принять around 2pm";
    expect(readyTimeWishes(note)).toEqual(["6 PM", "around 2pm"]);
    expect(readyTimeWishes(null)).toEqual([]);
  });

  it("подписи: клиенту по-английски, владельцу — «2 ч 2 мин»", () => {
    expect(clockLabelEn(14 * 60 + 30)).toBe("2:30 PM");
    expect(clockLabelEn(12 * 60)).toBe("12 PM");
    expect(clockLabelEn(9 * 60)).toBe("9 AM");
    expect(fmtDuration(42)).toBe("42 мин");
    expect(fmtDuration(122)).toBe("2 ч 2 мин");
    expect(fmtDuration(120)).toBe("2 ч");
  });
});

describe("замок дня (владелец 29.09.2026)", () => {
  it("утро — не раньше 15:00, только вечер — не раньше 18:00", () => {
    expect(withClosure(11 * 60, "MORNING", true)).toBe(15 * 60);
    expect(withClosure(16 * 60, "MORNING", true)).toBe(16 * 60);
    expect(withClosure(11 * 60, "DAY", true)).toBe(18 * 60);
    expect(withClosure(11 * 60, null, true)).toBe(11 * 60);
  });

  it("весь день закрыт: новому заказу — нельзя, принятый возим как обычно", () => {
    expect(withClosure(11 * 60, "FULL", true)).toBeNull();
    expect(withClosure(11 * 60, "FULL", false)).toBe(11 * 60);
  });

  it("неизвестный уровень из базы — не замок", () => {
    expect(asClosureLevel("DAY")).toBe("DAY");
    expect(asClosureLevel("WEEK")).toBeNull();
  });
});

describe("новый заказ на сегодня и главный магазин (владелец 29.09.2026)", () => {
  it("до 13:00 сегодня берём всегда: места нет — вечером", () => {
    expect(sameDayFallback(null, 12 * 60 + 59)).toBe(18 * 60);
    expect(sameDayFallback(14 * 60, 10 * 60)).toBe(14 * 60);
  });

  it("после 13:00 без места — сегодня уже нет", () => {
    expect(sameDayFallback(null, 13 * 60)).toBeNull();
  });

  it("главный магазин — TheFlow", () => {
    expect(isPriorityShop("THEFLOW")).toBe(true);
    expect(isPriorityShop("JF")).toBe(false);
    expect(isPriorityShop(null)).toBe(false);
  });
});
