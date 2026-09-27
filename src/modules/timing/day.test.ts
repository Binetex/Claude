import { describe, it, expect } from "vitest";
import { isBigOrder, readyTimeWishes, clockLabelEn, fmtDuration } from "./day";

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
