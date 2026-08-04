import { describe, it, expect, vi } from "vitest";
import { summarizeQuotes, isQuotesComplete } from "./quotes";
import { checkCourierAvailability, probeExternalRef } from "./courierCheck";
import type { BurqClient } from "./client";
import type { BurqCreateOrderRequest } from "./types";

/** Ответ Burq, снятый живым прогоном 04.08.2026 — форма именно такая. */
const REAL_RESPONSE = {
  object: "route_quotes",
  status: "COMPLETE",
  data: [
    { provider: "grubhub", cost_of_delivery: 2089, burq_fee: 99, expires_at: "2026-08-04T19:59:53.000Z" },
    { provider: "Uber", cost_of_delivery: 1849, burq_fee: 99, pickup_time: "2026-08-04T20:04:53Z" },
  ],
};

describe("разбор котировок", () => {
  it("считает провайдеров, находит Uber и самую дешёвую доставку", () => {
    const a = summarizeQuotes(REAL_RESPONSE);
    expect(a.count).toBe(2);
    expect(a.hasUber).toBe(true);
    expect(a.providers).toEqual(["grubhub", "Uber"]);
    // Полная стоимость = доставка + комиссия Burq: Uber 1849+99 дешевле grubhub 2089+99.
    expect(a.cheapestCents).toBe(1948);
  });

  it("имя провайдера сравнивается без учёта регистра", () => {
    expect(summarizeQuotes({ status: "COMPLETE", data: [{ provider: "uber" }] }).hasUber).toBe(true);
    expect(summarizeQuotes({ status: "COMPLETE", data: [{ provider: "UBER" }] }).hasUber).toBe(true);
    expect(summarizeQuotes({ status: "COMPLETE", data: [{ provider: "grubhub" }] }).hasUber).toBe(false);
  });

  it("пустой список — это «никто не берётся», а не ошибка", () => {
    const a = summarizeQuotes({ status: "COMPLETE", data: [] });
    expect(a.count).toBe(0);
    expect(a.hasUber).toBe(false);
    expect(a.cheapestCents).toBeNull();
  });

  it("PENDING читать нельзя — данных ещё нет", () => {
    expect(isQuotesComplete({ status: "PENDING", data: null })).toBe(false);
    expect(isQuotesComplete(REAL_RESPONSE)).toBe(true);
  });
});

function clientWith(overrides: Partial<BurqClient>): BurqClient {
  return {
    mode: "mock",
    createDraft: vi.fn(async () => ({ id: "o_probe" }) as never),
    getOrder: vi.fn(),
    deleteOrder: vi.fn(),
    createRoute: vi.fn(async () => ({ id: "rt_1" })),
    requestRouteQuotes: vi.fn(),
    listRouteQuotes: vi.fn(async () => REAL_RESPONSE),
    deleteRoute: vi.fn(),
    ...overrides,
  } as BurqClient;
}

const REQ = { items: [], external_order_ref: "orderX:a1" } as unknown as BurqCreateOrderRequest;

describe("проверка курьеров", () => {
  it("боевой черновик не трогается: котируется отдельный заказ-зонд", async () => {
    const createDraft = vi.fn(async () => ({ id: "o_probe" }) as never);
    const client = clientWith({ createDraft });

    await checkCourierAvailability(client, REQ, probeExternalRef("orderX", 1));

    // Зонд ушёл со СВОЕЙ ссылкой — спутать его с боевым заказом невозможно.
    const sentRef = (createDraft.mock.calls[0] as unknown as [BurqCreateOrderRequest])[0].external_order_ref;
    expect(sentRef).toBe("probe:orderX:a1");
    expect(sentRef).not.toBe("orderX:a1");
  });

  it("убирает за собой и зонд, и маршрут", async () => {
    const deleteOrder = vi.fn();
    const deleteRoute = vi.fn();
    const client = clientWith({ deleteOrder, deleteRoute });

    await checkCourierAvailability(client, REQ, "probe:x:a1");

    expect(deleteRoute).toHaveBeenCalledWith("rt_1");
    expect(deleteOrder).toHaveBeenCalledWith("o_probe");
  });

  it("прибирает за собой даже когда котировки упали", async () => {
    const deleteOrder = vi.fn();
    const deleteRoute = vi.fn();
    const client = clientWith({
      deleteOrder,
      deleteRoute,
      listRouteQuotes: vi.fn(async () => { throw new Error("boom"); }),
    });

    const res = await checkCourierAvailability(client, REQ, "probe:x:a1");

    expect(res.checked).toBe(false);
    expect(deleteRoute).toHaveBeenCalled();
    expect(deleteOrder).toHaveBeenCalled();
  });

  it("сбой любого шага НЕ выдаёт себя за «курьеров нет»", async () => {
    const client = clientWith({ createRoute: vi.fn(async () => { throw new Error("no route"); }) });
    const res = await checkCourierAvailability(client, REQ, "probe:x:a1");
    // checked=false — вызывающий ничего не запишет и никого не разбудит.
    expect(res).toEqual({ checked: false, reason: "Error" });
  });

  it("достоверный пустой ответ отдаётся как ноль курьеров", async () => {
    const client = clientWith({ listRouteQuotes: vi.fn(async () => ({ status: "COMPLETE", data: [] })) });
    const res = await checkCourierAvailability(client, REQ, "probe:x:a1");
    expect(res).toEqual({ checked: true, availability: { count: 0, hasUber: false, providers: [], cheapestCents: null } });
  });
});
