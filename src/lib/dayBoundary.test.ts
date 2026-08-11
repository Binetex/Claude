import { describe, it, expect } from "vitest";
import { todayStrInTz, utcDayRangeForLocalToday, utcMidnightOfLocalDay, parseLocalDayToUtcMidnight } from "./tz";
import { groupFor } from "@/modules/finance/issues";

/**
 * Граница суток: «сегодня» считается по календарю МАГАЗИНА, а не по UTC.
 *
 * Полночь UTC наступает в Лос-Анджелесе в 17:00. Каждое место, где «сегодня» выводилось из
 * момента времени через UTC, ошибалось на сутки все вечерние часы — и молча. Так потерялись
 * три заказа без доставки (PAR-41321 и другие), а записи в книге и очередь «Требует
 * заполнения» уезжали на следующий день.
 *
 * Здесь закреплена сама граница — 17:00 по Лос-Анджелесу, — чтобы возврат к UTC-сравнению
 * не прошёл незамеченным ни в одном из мест.
 */
const LA = "America/Los_Angeles";

/** 7 августа, 19:13 по Лос-Анджелесу — в UTC это уже 8-е. */
const EVENING = new Date("2026-08-08T02:13:41.000Z");
/** 7 августа, 17:00 — ровно полночь UTC. */
const MIDNIGHT_UTC = new Date("2026-08-08T00:00:01.000Z");
/** 7 августа, 10:00 — UTC и местная дата совпадают. */
const MORNING = new Date("2026-08-07T17:00:00.000Z");

describe("«сегодня» в таймзоне магазина", () => {
  it("вечером местная дата отстаёт от UTC на сутки", () => {
    expect(todayStrInTz(LA, EVENING)).toBe("2026-08-07");
    expect(EVENING.toISOString().slice(0, 10)).toBe("2026-08-08"); // а по UTC — уже завтра
  });

  it("на самой границе полуночи UTC день магазина ещё вчерашний", () => {
    expect(todayStrInTz(LA, MIDNIGHT_UTC)).toBe("2026-08-07");
  });

  it("днём расхождения нет", () => {
    expect(todayStrInTz(LA, MORNING)).toBe("2026-08-07");
  });

  it("без таймзоны берётся Лос-Анджелес, а не UTC", () => {
    // Часть магазинов заведена без таймзоны; молчаливый переход на UTC вернул бы ошибку.
    expect(todayStrInTz(null, EVENING)).toBe("2026-08-07");
    expect(todayStrInTz(undefined, EVENING)).toBe("2026-08-07");
  });
});

describe("окно локального дня для выборок по deliveryDate", () => {
  it("вечером нацелено на СЕГОДНЯШНИЙ местный день, а не на завтрашний", () => {
    // deliveryDate хранится как UTC-полночь локального дня — границы должны совпадать с ней.
    const { gte, lt } = utcDayRangeForLocalToday(LA, EVENING);
    expect(gte.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(lt.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  it("сегодняшний заказ попадает в окно, вчерашний и завтрашний — нет", () => {
    const { gte, lt } = utcDayRangeForLocalToday(LA, EVENING);
    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    expect(day("2026-08-07") >= gte && day("2026-08-07") < lt).toBe(true);
    expect(day("2026-08-06") >= gte).toBe(false);
    expect(day("2026-08-08") < lt).toBe(false);
  });
});

describe("utcMidnightOfLocalDay — момент времени → день доставки", () => {
  it("вечерний заказ остаётся СЕГОДНЯШНИМ днём, а не уезжает на завтра", () => {
    // 7 августа 19:13 в Лос-Анджелесе — в UTC уже 8-е. Сырой timestamp давал заказу 8 августа.
    expect(utcMidnightOfLocalDay(EVENING, LA).toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("ровно 17:00 по Лос-Анджелесу (полночь UTC) — всё ещё 7 августа", () => {
    expect(utcMidnightOfLocalDay(new Date("2026-08-08T00:00:00.000Z"), LA).toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("утренний заказ даёт свой же день", () => {
    expect(utcMidnightOfLocalDay(new Date("2026-08-07T16:00:00.000Z"), LA).toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("результат — ровно полночь, без остатка времени", () => {
    const d = utcMidnightOfLocalDay(new Date("2026-08-07T16:42:37.123Z"), LA);
    expect(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds()).toBe(0);
  });

  it("без таймзоны магазина берётся зона по умолчанию, а не UTC", () => {
    expect(utcMidnightOfLocalDay(EVENING, null).toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });
});

describe("parseLocalDayToUtcMidnight — дата доставки строкой", () => {
  const DAY = "2026-08-07T00:00:00.000Z";

  it("ISO-дата → тот же день", () => {
    expect(parseLocalDayToUtcMidnight("2026-08-07")?.toISOString()).toBe(DAY);
  });

  it("«человеческий» формат Shopify → тот же день, а не сдвиг по зоне сервера", () => {
    // Именно здесь пряталась мина: `new Date("August 7, 2026")` — это полночь в зоне ПРОЦЕССА.
    expect(parseLocalDayToUtcMidnight("August 7, 2026")?.toISOString()).toBe(DAY);
    expect(parseLocalDayToUtcMidnight("08/07/2026")?.toISOString()).toBe(DAY);
  });

  it("ISO с временем и смещением: берётся дата, как она написана", () => {
    expect(parseLocalDayToUtcMidnight("2026-08-07T23:30:00-07:00")?.toISOString()).toBe(DAY);
  });

  it("пусто или мусор → null, а не Invalid Date в БД", () => {
    expect(parseLocalDayToUtcMidnight(null)).toBeNull();
    expect(parseLocalDayToUtcMidnight("")).toBeNull();
    expect(parseLocalDayToUtcMidnight("   ")).toBeNull();
    expect(parseLocalDayToUtcMidnight("завтра после обеда")).toBeNull();
  });

  it("результат всегда ровная UTC-полночь", () => {
    const d = parseLocalDayToUtcMidnight("August 7, 2026")!;
    expect(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds()).toBe(0);
  });
});

describe("очередь «Требует заполнения»", () => {
  it("вечерняя проблема сегодняшнего дня остаётся в группе TODAY", () => {
    // По UTC она каждый вечер уезжала в LAST_7_DAYS, и владелец переставал её видеть сверху.
    expect(groupFor(new Date("2026-08-07T00:00:00.000Z"), EVENING)).toBe("TODAY");
  });

  it("вчерашняя — по-прежнему LAST_7_DAYS", () => {
    expect(groupFor(new Date("2026-08-06T00:00:00.000Z"), EVENING)).toBe("LAST_7_DAYS");
  });

  it("без даты — NO_DATE", () => {
    expect(groupFor(null, EVENING)).toBe("NO_DATE");
  });
});
