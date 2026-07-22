/**
 * Расчёт момента ежедневного триггера «Доставка сегодня». Проверяем таймзонную арифметику —
 * самое хрупкое место: 9:00 в Лос-Анджелесе и в Нью-Йорке это разные моменты UTC.
 */
import { describe, it, expect } from "vitest";
import { computeDailyTriggerAt, deliveryLocalDay } from "./dailySchedule";

describe("computeDailyTriggerAt", () => {
  const past = new Date("2026-07-20T00:00:00Z"); // раньше всех расчётных моментов

  it("9:00 в Лос-Анджелесе летом = 16:00 UTC", () => {
    expect(computeDailyTriggerAt("2026-07-24", "09:00", "America/Los_Angeles", past).toISOString())
      .toBe("2026-07-24T16:00:00.000Z");
  });

  it("9:00 в Нью-Йорке летом = 13:00 UTC — таймзона магазина учитывается", () => {
    expect(computeDailyTriggerAt("2026-07-24", "09:00", "America/New_York", past).toISOString())
      .toBe("2026-07-24T13:00:00.000Z");
  });

  it("своё время магазина вместо 9:00", () => {
    expect(computeDailyTriggerAt("2026-07-24", "07:30", "America/Los_Angeles", past).toISOString())
      .toBe("2026-07-24T14:30:00.000Z");
  });

  it("пустое время → по умолчанию 9:00", () => {
    expect(computeDailyTriggerAt("2026-07-24", null, "America/Los_Angeles", past).toISOString())
      .toBe("2026-07-24T16:00:00.000Z");
  });

  it("момент уже прошёл (заказ на сегодня создан после рассылки) → доступно сразу", () => {
    const now = new Date("2026-07-24T20:00:00Z"); // 13:00 в LA, позже 9:00
    expect(computeDailyTriggerAt("2026-07-24", "09:00", "America/Los_Angeles", now)).toEqual(now);
  });

  it("зимой сдвиг другой — DST не ломает расчёт", () => {
    const beforeWinter = new Date("2026-01-01T00:00:00Z"); // раньше расчётного момента
    expect(computeDailyTriggerAt("2026-01-15", "09:00", "America/Los_Angeles", beforeWinter).toISOString())
      .toBe("2026-01-15T17:00:00.000Z");
  });
});

describe("deliveryLocalDay", () => {
  it("берёт UTC-календарную дату: поле хранит UTC-полночь ЛОКАЛЬНОГО дня", () => {
    expect(deliveryLocalDay(new Date("2026-07-24T00:00:00Z"))).toBe("2026-07-24");
  });
});
