import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handleCourierPrecheck, precheckExternalRef, courierCheckIdempotencyKey, type CourierPrecheckPort } from "./precheck";
import type { BurqClient } from "./client";

const dropoff = {
  id: "o1",
  recipientName: "R",
  recipientPhone: "+13105550101",
  addressLine: "1 Main St",
  apartmentOrSuite: null,
  city: "Los Angeles",
  state: "CA",
  zip: "90001",
  deliveryDate: new Date("2026-09-10T00:00:00Z"),
  deliveryWindow: "10:00 - 14:00",
  courierNote: null,
  items: [],
};

const pickup = {
  id: "p1",
  locationName: "Olga",
  contactName: "Olga",
  contactPhone: "+13105550102",
  addressLine: "2 Second St",
  apartmentOrSuite: null,
  city: "North Hills",
  state: "CA",
  zip: "91343",
  courierInstructions: null,
  isActive: true,
};

function ctx(over: Record<string, unknown> = {}) {
  return {
    order: {
      id: "o1",
      orderStatus: "CONFIRMED",
      scheduleVersion: 0,
      siteAutoCreateEnabled: true,
      deliveryDate: dropoff.deliveryDate,
      timezone: "America/Los_Angeles",
      dropoff,
    },
    floristId: "f1",
    pickup,
    pickupLocationId: "p1",
    hasCurrentDraft: false,
    nextAttemptNumber: 1,
    ...over,
  };
}

function port(over: Partial<CourierPrecheckPort> = {}, recorded: unknown[] = []): CourierPrecheckPort {
  return {
    loadContext: vi.fn(async () => ctx() as never),
    recordOrderCourierAvailability: vi.fn(async (i) => { recorded.push(i); }),
    ...over,
  } as CourierPrecheckPort;
}

/** Клиент-заглушка: важен только путь «зонд → маршрут → котировки → удаление». */
function client(quotes: { provider?: string }[] | null): BurqClient {
  return {
    mode: "mock",
    createDraft: vi.fn(async () => ({ id: "probe1", status: "draft", checkoutUrl: null })),
    createRoute: vi.fn(async () => ({ id: "route1" })),
    requestRouteQuotes: vi.fn(async () => {}),
    listRouteQuotes: vi.fn(async () => (quotes === null ? null : { status: "COMPLETE", data: quotes })),
    deleteRoute: vi.fn(async () => {}),
    deleteOrder: vi.fn(async () => {}),
  } as unknown as BurqClient;
}

describe("предварительная проверка курьеров", () => {
  it("без флориста не спрашивает Burq вовсе", async () => {
    const c = client([]);
    const res = await handleCourierPrecheck(
      { client: c, port: port({ loadContext: vi.fn(async () => ctx({ floristId: null, pickup: null }) as never) }) },
      { orderId: "o1", checkVersion: 0 }
    );
    expect(res).toEqual({ outcome: "skipped", reason: "no_florist" });
    expect(c.createDraft).not.toHaveBeenCalled();
  });

  it("флорист есть, а точки забора нет — тоже не спрашивает", async () => {
    const c = client([]);
    const res = await handleCourierPrecheck(
      { client: c, port: port({ loadContext: vi.fn(async () => ctx({ pickup: null }) as never) }) },
      { orderId: "o1", checkVersion: 0 }
    );
    expect(res).toEqual({ outcome: "skipped", reason: "no_pickup" });
    expect(c.createDraft).not.toHaveBeenCalled();
  });

  it("отменённый заказ не проверяем", async () => {
    const c = client([]);
    const res = await handleCourierPrecheck(
      { client: c, port: port({ loadContext: vi.fn(async () => ctx({ order: { ...ctx().order, orderStatus: "CANCELLED" } }) as never) }) },
      { orderId: "o1", checkVersion: 0 }
    );
    expect(res).toEqual({ outcome: "skipped", reason: "order_terminal" });
    expect(c.createDraft).not.toHaveBeenCalled();
  });

  it("курьеры нашлись — результат записывается на заказ", async () => {
    const recorded: unknown[] = [];
    const res = await handleCourierPrecheck(
      { client: client([{ provider: "uber" }, { provider: "doordash" }]), port: port({}, recorded) },
      { orderId: "o1", checkVersion: 0 }
    );
    expect(res).toEqual({ outcome: "checked", count: 2 });
    expect(recorded[0]).toMatchObject({ orderId: "o1", count: 2, hasUber: true });
  });

  it("курьеров нет — записывается ноль, а не «не проверяли»", async () => {
    const recorded: unknown[] = [];
    const res = await handleCourierPrecheck({ client: client([]), port: port({}, recorded) }, { orderId: "o1", checkVersion: 0 });
    expect(res).toEqual({ outcome: "checked", count: 0 });
    expect(recorded[0]).toMatchObject({ count: 0 });
  });

  it("зонд помечен так, что его не спутать с боевым заказом", () => {
    expect(precheckExternalRef("o1", 2)).toBe("precheck-o1-v2");
  });

  it("новая версия данных — новая проверка, а не дубль", () => {
    expect(courierCheckIdempotencyKey("o1", 0)).not.toBe(courierCheckIdempotencyKey("o1", 1));
  });
});
