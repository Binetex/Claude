import { describe, it, expect } from "vitest";
import { pickRecipient, storeHour, OWNER_UNTIL_HOUR } from "./routing";

/**
 * Кому уходит черновик. Ошибка здесь не ломает систему, но делает её бесполезной: черновик,
 * улетевший не тому, просто никто не подтвердит, и клиент останется без ответа.
 */
describe("час по времени магазина", () => {
  it("считается по календарю магазина, а не сервера", () => {
    // 19:00 UTC — это 12:00 в Лос-Анджелесе (летнее время).
    expect(storeHour("America/Los_Angeles", new Date("2026-09-05T19:00:00.000Z"))).toBe(12);
    expect(storeHour("America/Los_Angeles", new Date("2026-09-05T16:30:00.000Z"))).toBe(9);
  });

  it("таймзона не задана — считаем по Лос-Анджелесу", () => {
    expect(storeHour(null, new Date("2026-09-05T19:00:00.000Z"))).toBe(12);
  });
});

describe("кому нести черновик", () => {
  it("утром — владельцу", () => {
    expect(pickRecipient({ storeHour: 9, hasFlorist: true })).toBe("OWNER");
    expect(pickRecipient({ storeHour: OWNER_UNTIL_HOUR - 1, hasFlorist: true })).toBe("OWNER");
  });

  it("с полудня — флористу заказа", () => {
    expect(pickRecipient({ storeHour: OWNER_UNTIL_HOUR, hasFlorist: true })).toBe("FLORIST");
    expect(pickRecipient({ storeHour: 20, hasFlorist: true })).toBe("FLORIST");
  });

  it("флориста на заказе нет — всё равно владельцу", () => {
    expect(pickRecipient({ storeHour: 15, hasFlorist: false })).toBe("OWNER");
  });
});
