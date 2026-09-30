import { describe, it, expect } from "vitest";
import { isHistoricalOrder } from "./historical";

const LA = "America/Los_Angeles";
// 30.09.2026, 13:53 по Лос-Анджелесу — когда пришли вебхуки по заказам 2025 года.
const now = new Date("2026-09-30T20:53:00Z");
const day = (d: string) => new Date(`${d}T00:00:00Z`);

describe("заказ из прошлого не становится живым", () => {
  it("THEFLOW-15339 и THEFLOW-17708: доставка в 2025, оформлены в 2025 — прошлое", () => {
    expect(isHistoricalOrder({ deliveryDate: day("2025-03-13"), createdAt: new Date("2025-03-13T13:51:40Z"), now, timezone: LA })).toBe(true);
    expect(isHistoricalOrder({ deliveryDate: day("2025-10-10"), createdAt: new Date("2025-10-09T15:55:04Z"), now, timezone: LA })).toBe(true);
  });

  it("живые: доставка завтра, сегодня, вчера; оформлен давно, но на будущую дату", () => {
    expect(isHistoricalOrder({ deliveryDate: day("2026-10-01"), createdAt: new Date("2026-09-30T21:12:17Z"), now, timezone: LA })).toBe(false);
    expect(isHistoricalOrder({ deliveryDate: day("2026-09-30"), createdAt: new Date("2026-09-20T10:00:00Z"), now, timezone: LA })).toBe(false);
    expect(isHistoricalOrder({ deliveryDate: day("2026-09-29"), createdAt: new Date("2026-09-20T10:00:00Z"), now, timezone: LA })).toBe(false);
  });

  it("свежий заказ с датой доставки в прошлом (ошибка клиента) — живой: разберутся люди", () => {
    expect(isHistoricalOrder({ deliveryDate: day("2026-09-01"), createdAt: new Date("2026-09-30T18:00:00Z"), now, timezone: LA })).toBe(false);
  });
});
