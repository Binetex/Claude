/**
 * Расчёт момента ежедневного триггера «Доставка сегодня». Проверяем таймзонную арифметику —
 * самое хрупкое место: 9:00 в Лос-Анджелесе и в Нью-Йорке это разные моменты UTC.
 */
import { describe, it, expect } from "vitest";
import { computeDailyTriggerAt, deliveryLocalDay, isDeliveryToday } from "./dailySchedule";

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

describe("isDeliveryToday — тот самый сдвиг на сутки", () => {
  const tz = "America/Los_Angeles";
  // Order.deliveryDate = UTC-полночь ЛОКАЛЬНОГО дня доставки.
  const deliveryToday = new Date("2026-07-22T00:00:00Z");

  it("same-day заказ, пришедший в 14:00 по местному → триггер срабатывает", () => {
    expect(isDeliveryToday(deliveryToday, tz, new Date("2026-07-22T21:00:00Z"))).toBe(true);
  });

  it("раннее утро того же локального дня → тоже срабатывает", () => {
    // 08:00 в Лос-Анджелесе = 15:00 UTC того же числа.
    expect(isDeliveryToday(deliveryToday, tz, new Date("2026-07-22T15:00:00Z"))).toBe(true);
  });

  it("поздний вечер по UTC, но ещё тот же день в Лос-Анджелесе → срабатывает", () => {
    // 23:30 UTC = 16:30 в LA того же числа.
    expect(isDeliveryToday(deliveryToday, tz, new Date("2026-07-22T23:30:00Z"))).toBe(true);
  });

  it("доставка завтра → НЕ срабатывает", () => {
    expect(isDeliveryToday(new Date("2026-07-23T00:00:00Z"), tz, new Date("2026-07-22T21:00:00Z"))).toBe(false);
  });

  it("доставка вчера (устаревшая задача) → НЕ срабатывает", () => {
    expect(isDeliveryToday(new Date("2026-07-21T00:00:00Z"), tz, new Date("2026-07-22T21:00:00Z"))).toBe(false);
  });

  it("без таймзоны магазина берётся дефолтная зона", () => {
    expect(isDeliveryToday(deliveryToday, null, new Date("2026-07-22T21:00:00Z"))).toBe(true);
  });
});
