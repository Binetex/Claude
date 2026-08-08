import { describe, it, expect } from "vitest";
import { decideDraftEligibility, isPastDeliveryDate } from "./eligibility";

/**
 * «Дата доставки прошла» считается по календарю МАГАЗИНА, а не по UTC.
 *
 * Цена ошибки известна: полночь UTC наступает в Лос-Анджелесе в 17:00, и при сравнении по
 * UTC любой вечерний заказ на сегодня выглядел «вчерашним». Автосоздание доставки молча
 * пропускалось — за июль-август так потерялись три заказа, последний PAR-41321: приняли в
 * 19:13 по местному времени в день доставки, система решила, что день прошёл.
 */
const LA = "America/Los_Angeles";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`); // UTC-полночь локального дня

/** Полный набор условий «всё в порядке» — меняем только дату и время. */
const ok = {
  siteAutoCreateEnabled: true,
  orderStatus: "FLORIST_ACCEPTED",
  floristId: "f1",
  pickup: {
    locationName: "Olga",
    contactName: "Delivery",
    contactPhone: "+18186191064",
    addressLine: "16312 Itasca St",
    city: "North Hills",
    state: "CA",
    zip: "91343",
    isActive: true,
  },
  hasCurrentDraft: false,
  timezone: LA,
};

describe("вечерний заказ на сегодня", () => {
  it("19:13 по Лос-Анджелесу в день доставки — черновик СОЗДАЁТСЯ", () => {
    // Ровно случай PAR-41321: по UTC уже 8 августа, но в магазине всё ещё 7-е.
    const now = new Date("2026-08-08T02:13:41.000Z");
    expect(isPastDeliveryDate(day("2026-08-07"), now, LA)).toBe(false);
    expect(decideDraftEligibility({ ...ok, deliveryDate: day("2026-08-07"), now })).toEqual({ action: "CREATE_DRAFT" });
  });

  it("17:00 по Лос-Анджелесу — та самая граница полуночи UTC", () => {
    const now = new Date("2026-08-08T00:00:01.000Z"); // 07.08 17:00 PDT
    expect(isPastDeliveryDate(day("2026-08-07"), now, LA)).toBe(false);
  });

  it("вчерашний заказ по-прежнему пропускается", () => {
    // Защита от лавины по историческому бэклогу должна остаться рабочей.
    const now = new Date("2026-08-08T02:13:41.000Z"); // 07.08 19:13 PDT
    expect(isPastDeliveryDate(day("2026-08-06"), now, LA)).toBe(true);
    expect(decideDraftEligibility({ ...ok, deliveryDate: day("2026-08-06"), now })).toEqual({
      action: "SKIP",
      reason: "delivery_date_past",
    });
  });

  it("завтрашний — не прошедший", () => {
    const now = new Date("2026-08-08T02:13:41.000Z");
    expect(isPastDeliveryDate(day("2026-08-08"), now, LA)).toBe(false);
  });

  it("без таймзоны магазина считается по Лос-Анджелесу, а не по UTC", () => {
    // У части магазинов таймзона не заполнена; молча переходить на UTC нельзя — вернётся
    // ровно та же потеря вечерних заказов.
    const now = new Date("2026-08-08T02:13:41.000Z");
    expect(isPastDeliveryDate(day("2026-08-07"), now, null)).toBe(false);
    expect(isPastDeliveryDate(day("2026-08-07"), now, undefined)).toBe(false);
  });
});

describe("остальные условия не задеты", () => {
  const now = new Date("2026-08-08T02:13:41.000Z");
  const today = day("2026-08-07");

  it("выключено у магазина — пропуск", () => {
    expect(decideDraftEligibility({ ...ok, siteAutoCreateEnabled: false, deliveryDate: today, now })).toEqual({
      action: "SKIP",
      reason: "site_disabled",
    });
  });

  it("нет флориста — ждём", () => {
    expect(decideDraftEligibility({ ...ok, floristId: null, deliveryDate: today, now })).toEqual({
      action: "WAIT_FOR_FLORIST",
      reason: "no_florist",
    });
  });

  it("черновик уже есть — пропуск", () => {
    expect(decideDraftEligibility({ ...ok, hasCurrentDraft: true, deliveryDate: today, now })).toEqual({
      action: "SKIP",
      reason: "draft_exists",
    });
  });
});
