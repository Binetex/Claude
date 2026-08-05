import { describe, it, expect } from "vitest";
import { isFloristAvailable, businessDayKey } from "./availability";

/** deliveryDate хранится как UTC-полночь локального дня — так его и строим. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const free = { weekendDays: [], daysOff: [] };

describe("доступность флориста", () => {
  it("без настроек доступен всегда — новому ничего заполнять не нужно", () => {
    expect(isFloristAvailable(free, day("2026-08-15"))).toBe(true);
  });

  it("выходной по дню недели", () => {
    // 15 августа 2026 — суббота, 17-е — понедельник.
    const noWeekends = { weekendDays: [6, 0], daysOff: [] };
    expect(isFloristAvailable(noWeekends, day("2026-08-15"))).toBe(false);
    expect(isFloristAvailable(noWeekends, day("2026-08-16"))).toBe(false);
    expect(isFloristAvailable(noWeekends, day("2026-08-17"))).toBe(true);
  });

  it("отдельная дата недоступности", () => {
    const vacation = { weekendDays: [], daysOff: [day("2026-08-20")] };
    expect(isFloristAvailable(vacation, day("2026-08-20"))).toBe(false);
    expect(isFloristAvailable(vacation, day("2026-08-21"))).toBe(true);
  });

  it("дата сравнивается по КАЛЕНДАРНОМУ дню, а не по мгновению", () => {
    // Если бы где-то сохранили дату с временем, день всё равно должен совпасть.
    const withTime = { weekendDays: [], daysOff: [new Date("2026-08-20T13:45:00.000Z")] };
    expect(isFloristAvailable(withTime, day("2026-08-20"))).toBe(false);
  });

  it("день недели читается в UTC и не съезжает на сутки", () => {
    // Ловушка проекта: deliveryDate уже переведён в бизнес-день при записи. Если прочитать
    // его через таймзону магазина (LA, −7), UTC-полночь станет предыдущим вечером, и
    // суббота превратилась бы в пятницу. Здесь этого не происходит.
    const saturday = day("2026-08-15");
    expect(saturday.getUTCDay()).toBe(6);
    expect(isFloristAvailable({ weekendDays: [6], daysOff: [] }, saturday)).toBe(false);
    expect(isFloristAvailable({ weekendDays: [5], daysOff: [] }, saturday)).toBe(true);
  });

  it("ключ дня — календарная дата в UTC", () => {
    expect(businessDayKey(new Date("2026-08-20T23:59:00.000Z"))).toBe("2026-08-20");
  });
});
