import { describe, it, expect } from "vitest";
import { localDateStr, todayStrInTz, isValidTimeZone, utcDayRangeForLocalToday, deliveryDayBucket, DEFAULT_STORE_TZ } from "@/lib/tz";

describe("localDateStr — «сегодня» по таймзоне магазина", () => {
  it("возвращает дату в указанной таймзоне, не в UTC", () => {
    // 05:00 UTC = 22:00 предыдущего дня в Лос-Анджелесе (UTC-7 летом).
    const d = new Date("2026-07-17T05:00:00Z");
    expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-07-16");
    expect(localDateStr(d, "UTC")).toBe("2026-07-17");
  });
});

describe("граница суток (UTC уже завтра, а в LA ещё сегодня)", () => {
  // 2026-07-19 05:00 UTC = 2026-07-18 22:00 в Лос-Анджелесе (PDT, UTC−7).
  const nightInLA = new Date("2026-07-19T05:00:00.000Z");

  it("тот же момент — разные календарные дни в UTC и в LA", () => {
    expect(localDateStr(nightInLA, "UTC")).toBe("2026-07-19");
    expect(localDateStr(nightInLA, "America/Los_Angeles")).toBe("2026-07-18");
  });

  it("utcDayRangeForLocalToday нацелен на ЛОКАЛЬНЫЙ день (18-е), а не на UTC-день (19-е)", () => {
    const { gte, lt } = utcDayRangeForLocalToday("America/Los_Angeles", nightInLA);
    expect(gte.toISOString()).toBe("2026-07-18T00:00:00.000Z");
    expect(lt.toISOString()).toBe("2026-07-19T00:00:00.000Z");
  });

  it("заказ с deliveryDate = UTC-полночь локального дня остаётся в правильном локальном дне", () => {
    const { gte, lt } = utcDayRangeForLocalToday("America/Los_Angeles", nightInLA);
    const deliveryToday = new Date("2026-07-18T00:00:00.000Z");
    const deliveryTomorrow = new Date("2026-07-19T00:00:00.000Z");
    expect(deliveryToday >= gte && deliveryToday < lt).toBe(true);
    expect(deliveryTomorrow >= gte && deliveryTomorrow < lt).toBe(false);
  });

  it("для UTC тот же момент даёт день 19-е (контроль)", () => {
    expect(utcDayRangeForLocalToday("UTC", nightInLA).gte.toISOString()).toBe("2026-07-19T00:00:00.000Z");
  });
});

describe("валидация и дефолт", () => {
  it("isValidTimeZone", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it("todayStrInTz с пустой зоной падает на дефолт (LA) и даёт валидный формат", () => {
    expect(DEFAULT_STORE_TZ).toBe("America/Los_Angeles");
    expect(todayStrInTz(null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("deliveryDayBucket — примитив будущего per-site расчёта метрик", () => {
  const now = new Date("2026-07-19T05:00:00.000Z"); // UTC 19-е; в LA ещё 18-е
  const d18 = new Date("2026-07-18T00:00:00.000Z");
  const d19 = new Date("2026-07-19T00:00:00.000Z");
  const d17 = new Date("2026-07-17T00:00:00.000Z");

  it("классифицирует относительно локального дня магазина (LA)", () => {
    expect(deliveryDayBucket(d18, "America/Los_Angeles", now)).toBe("today");
    expect(deliveryDayBucket(d19, "America/Los_Angeles", now)).toBe("tomorrow");
    expect(deliveryDayBucket(d17, "America/Los_Angeles", now)).toBe("other");
  });

  it("ОДИН и тот же заказ/момент в РАЗНЫХ зонах попадает в разные корзины (зачем нужен per-site)", () => {
    // deliveryDate = 19-е UTC-полночь. В LA сейчас 18-е → это «завтра». В UTC сейчас 19-е → «сегодня».
    expect(deliveryDayBucket(d19, "America/Los_Angeles", now)).toBe("tomorrow");
    expect(deliveryDayBucket(d19, "UTC", now)).toBe("today");
    // → глобальный единый tz на границе суток даёт разный результат: будущие метрики считать по Site.timezone.
  });
});
