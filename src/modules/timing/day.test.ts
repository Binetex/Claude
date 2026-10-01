import { describe, it, expect } from "vitest";
import { isBigOrder, readyTimeWishes, clockLabelEn, fmtDuration, withClosure, sameDayFallback, isPriorityShop, asClosureLevel, morningOverload } from "./day";

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

  it("«утро закрыто» и «только вечер» принятый заказ не двигают — замок только для новых", () => {
    expect(withClosure(11 * 60, "MORNING", false)).toBe(11 * 60);
    expect(withClosure(11 * 60, "DAY", false)).toBe(11 * 60);
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

describe("автозамок утра (владелец 01.10.2026)", () => {
  const morning = { from: 11 * 60, to: 15 * 60 };
  const o = (id: string, plannedAt: number | null, extra: Partial<{ site: string; promised: { from: number; to: number } | null }> = {}) => ({
    id, orderNumber: id, site: "THEFLOW", plannedAt, promised: morning, ...extra,
  });

  it("закрываем, когда утренний TheFlow опаздывает на час и больше — по самому опаздывающему", () => {
    // Реальный день 01.10: 20889 +49 мин, 20890 +1 ч 31 мин, 20885 +2 ч 41 мин.
    const day = [o("20888", 14 * 60 + 21), o("20889", 15 * 60 + 49), o("20890", 16 * 60 + 31), o("20885", 17 * 60 + 41)];
    expect(morningOverload(day)).toEqual({ id: "20885", orderNumber: "20885", lateMin: 161 });
  });

  it("опоздание меньше часа — не закрываем", () => {
    expect(morningOverload([o("a", 15 * 60 + 59)])).toBeNull();
    expect(morningOverload([o("a", 16 * 60)])).toEqual({ id: "a", orderNumber: "a", lateMin: 60 });
  });

  it("чужие магазины, вечерние окна, готовые букеты и заказы без окна не считаются", () => {
    expect(morningOverload([o("par", 18 * 60, { site: "PAR" })])).toBeNull();
    expect(morningOverload([o("eve", 21 * 60, { promised: { from: 15 * 60, to: 19 * 60 } })])).toBeNull();
    expect(morningOverload([o("ready", null)])).toBeNull();
    expect(morningOverload([o("nowin", 20 * 60, { promised: null })])).toBeNull();
  });
});
