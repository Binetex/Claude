import { describe, it, expect, afterEach, vi } from "vitest";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import {
  scheduleDeliveryForNewOrder,
  onOrderDeliveryChange,
  rescheduleDeliveryForOrder,
  rescheduleFloristWaitingOrders,
  rescheduleSiteFutureOrders,
} from "./scheduleService";
import { reconcileBurqSchedules } from "./recovery";
import { buildBurqDraftCreateHandler } from "./outboxHandler";
import { buildBurqWebhookHandler } from "./webhookHandler";
import { intakeBurqWebhook } from "./webhookIntake";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";

/**
 * Master gate BURQ_RUNTIME_ENABLED. При false ВСЯ runtime-логика Burq — полный no-op:
 * scheduler/ingest/assignment/pickup/tz hooks, recovery, worker handlers, webhook intake.
 * Проверяем throwing-proxy prisma: если путь тронет БД при выключенном gate — тест упадёт.
 */

// Прокси, бросающий на ЛЮБОЙ доступ к БД: гарантия, что путь не выполняет работу.
const throwingPrisma = new Proxy(
  {},
  {
    get() {
      throw new Error("DB accessed while gate OFF — runtime gate leaked!");
    },
  }
) as unknown as PrismaClient;

const fakeRecord = (payload: unknown): OutboxRecord =>
  ({ id: "e1", payload, eventType: "x", aggregateType: "order", aggregateId: "o1" }) as unknown as OutboxRecord;

function setGate(on: boolean) {
  if (on) process.env.BURQ_RUNTIME_ENABLED = "true";
  else delete process.env.BURQ_RUNTIME_ENABLED;
}

afterEach(() => {
  delete process.env.BURQ_RUNTIME_ENABLED;
  vi.unstubAllGlobals();
});

describe("isBurqRuntimeEnabled", () => {
  it("по умолчанию выключен; включается только строкой 'true'", () => {
    setGate(false);
    expect(isBurqRuntimeEnabled()).toBe(false);
    process.env.BURQ_RUNTIME_ENABLED = "1";
    expect(isBurqRuntimeEnabled()).toBe(false); // только "true"
    process.env.BURQ_RUNTIME_ENABLED = "true";
    expect(isBurqRuntimeEnabled()).toBe(true);
  });
});

describe("gate OFF → все runtime-пути no-op (БД не трогается)", () => {
  it("scheduleDeliveryForNewOrder", async () => {
    setGate(false);
    await expect(scheduleDeliveryForNewOrder(throwingPrisma, "o1")).resolves.toEqual({ scheduled: false, availableAt: null });
  });
  it("onOrderDeliveryChange (assignment/date/address/pickup hooks)", async () => {
    setGate(false);
    await expect(onOrderDeliveryChange(throwingPrisma, "o1")).resolves.toBeUndefined();
  });
  it("rescheduleDeliveryForOrder", async () => {
    setGate(false);
    await expect(rescheduleDeliveryForOrder(throwingPrisma, "o1")).resolves.toEqual({ availableAt: null });
  });
  it("rescheduleFloristWaitingOrders (pickup update)", async () => {
    setGate(false);
    await expect(rescheduleFloristWaitingOrders(throwingPrisma, "flo1")).resolves.toBe(0);
  });
  it("rescheduleSiteFutureOrders (timezone change)", async () => {
    setGate(false);
    await expect(rescheduleSiteFutureOrders(throwingPrisma, "site1")).resolves.toBe(0);
  });
  it("reconcileBurqSchedules (recovery)", async () => {
    setGate(false);
    await expect(reconcileBurqSchedules(throwingPrisma)).resolves.toEqual({ scanned: 0, rescheduled: 0 });
  });
  it("worker handler burq.draft.create.requested → no-op", async () => {
    setGate(false);
    const handler = buildBurqDraftCreateHandler(throwingPrisma);
    await expect(handler(fakeRecord({ orderId: "o1", scheduleVersion: 0 }))).resolves.toBeUndefined();
  });
  it("worker handler burq.webhook.received → no-op", async () => {
    setGate(false);
    const handler = buildBurqWebhookHandler(throwingPrisma);
    await expect(handler(fakeRecord({ externalDeliveryId: "d1", rawStatus: "delivered", providerEventId: "p" }))).resolves.toBeUndefined();
  });
  it("webhook intake → 503 disabled, без verify/enqueue и без сетевого вызова", async () => {
    setGate(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await intakeBurqWebhook({ rawBody: '{"x":1}', headers: { "burq-signature": "t=1,v1=abc" } });
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("gate ON → путь ДЕЙСТВИТЕЛЬНО работает (доходит до БД)", () => {
  it("scheduleDeliveryForNewOrder при gate ON трогает БД (доказывает, что блокирует именно gate)", async () => {
    setGate(true);
    await expect(scheduleDeliveryForNewOrder(throwingPrisma, "o1")).rejects.toThrow(/runtime gate leaked|DB accessed/);
  });
  it("reconcileBurqSchedules при gate ON трогает БД", async () => {
    setGate(true);
    await expect(reconcileBurqSchedules(throwingPrisma)).rejects.toThrow();
  });
});
