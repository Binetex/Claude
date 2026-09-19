import { describe, it, expect } from "vitest";
import { fmtStoreDateTime, fmtStoreTime, fmtStoreDate, storeTz, storeTzLabel } from "./tz";

/**
 * Жалоба владельца 19.09.2026: «КУРЬЕР ВЫЗВАН 19.09.2026, 00:08» — московское время по заказу
 * в Лос-Анджелесе. Момент ниже — ровно тот: 2026-09-18T21:08Z это 00:08 в Москве и 14:08 в LA.
 */
const MOMENT = new Date("2026-09-18T21:08:00.000Z");

describe("показ времени по часам магазина", () => {
  it("тот самый случай: показываем 14:08 по LA, а не 00:08 по Москве", () => {
    expect(fmtStoreDateTime(MOMENT, "America/Los_Angeles")).toBe("18.09.2026, 14:08 PDT");
  });

  it("таймзона магазина не задана — берём Лос-Анджелес, а НЕ часы того, кто смотрит", () => {
    // Ровно эта дыра и была: `?? undefined` уводил формат в зону браузера.
    expect(fmtStoreDateTime(MOMENT, null)).toBe("18.09.2026, 14:08 PDT");
    expect(fmtStoreDateTime(MOMENT, undefined)).toBe("18.09.2026, 14:08 PDT");
    expect(fmtStoreDateTime(MOMENT, "")).toBe("18.09.2026, 14:08 PDT");
  });

  it("мусор вместо таймзоны не роняет страницу и не уводит в чужую зону", () => {
    expect(fmtStoreDateTime(MOMENT, "Не/Зона")).toBe("18.09.2026, 14:08 PDT");
    expect(storeTz("Не/Зона")).toBe("America/Los_Angeles");
  });

  it("зимой подпись меняется на PST: смещение считается на сам момент, а не на сегодня", () => {
    const winter = new Date("2026-01-15T21:08:00.000Z");
    expect(storeTzLabel(null, winter)).toBe("PST");
    expect(fmtStoreDateTime(winter, null)).toBe("15.01.2026, 13:08 PST");
  });

  it("в ленте сообщений зона не дублируется в каждой строке", () => {
    expect(fmtStoreTime(MOMENT, null)).toBe("14:08");
    expect(fmtStoreTime(MOMENT, null, { withZone: true })).toBe("14:08 PDT");
  });

  it("пустое значение — прочерк, а не «Invalid Date»", () => {
    expect(fmtStoreDateTime(null, null)).toBe("—");
    expect(fmtStoreDateTime("", null)).toBe("—");
    expect(fmtStoreTime(undefined, null)).toBe("—");
    expect(fmtStoreDate("не дата", null)).toBe("—");
  });

  it("дата без времени тоже считается по часам магазина", () => {
    // 2026-09-19T05:30Z — в LA это ещё 18 сентября.
    expect(fmtStoreDate(new Date("2026-09-19T05:30:00.000Z"), null)).toBe("18.09.2026");
  });
});
