import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Реконсиляция расписаний Burq — самостраховка от потерянной задачи.
 *
 * Цена ошибки известна: она не смотрела на МЁРТВЫЕ задачи и раз в час ставила заново ту,
 * что уже восемь раз не прошла. Ограничение повторов переставало существовать, а владелец
 * каждый час получал одно и то же «Событие потеряно» (M-THEFLOW-002 — семь одинаковых
 * сообщений за вечер, 57 мёртвых задач в очереди).
 */
vi.mock("@/lib/featureFlags", () => ({ isBurqRuntimeEnabled: () => true }));

const rescheduleSpy = vi.fn(async () => ({ availableAt: null }));
vi.mock("./scheduleService", () => ({ rescheduleDeliveryForOrder: () => rescheduleSpy() }));

vi.mock("./draftPort.prisma", () => ({
  createPrismaDraftPort: () => ({
    loadContext: async () => ({
      order: {
        id: "o1",
        orderStatus: "FLORIST_ACCEPTED",
        siteAutoCreateEnabled: true,
        deliveryDate: new Date("2026-08-08T00:00:00.000Z"),
        timezone: "America/Los_Angeles",
      },
      floristId: "f1",
      pickup: {
        locationName: "P",
        contactName: "C",
        contactPhone: "+18186191064",
        addressLine: "1 St",
        city: "LA",
        state: "CA",
        zip: "90001",
        isActive: true,
      },
      hasCurrentDraft: false,
    }),
  }),
}));

const { reconcileBurqSchedules } = await import("./recovery");

/** Прима с одним заказом-кандидатом и заданным состоянием его задачи. */
const fakePrisma = (taskStatus: string | null) =>
  ({
    order: { findMany: async () => [{ id: "o1" }] },
    outboxEvent: {
      findFirst: async () => (taskStatus ? { status: taskStatus } : null),
    },
  }) as unknown as PrismaClient;

const NOW = new Date("2026-08-08T12:00:00.000Z");

beforeEach(() => rescheduleSpy.mockClear());

describe("реконсиляция и состояние задачи", () => {
  it("МЁРТВУЮ задачу не воскрешает — иначе бесконечный круг уведомлений", async () => {
    const r = await reconcileBurqSchedules(fakePrisma("DEAD_LETTER"), NOW);
    expect(rescheduleSpy).not.toHaveBeenCalled();
    expect(r.rescheduled).toBe(0);
  });

  it("живую не трогает — она отработает сама", async () => {
    for (const status of ["PENDING", "PROCESSING"]) {
      rescheduleSpy.mockClear();
      const r = await reconcileBurqSchedules(fakePrisma(status), NOW);
      expect(rescheduleSpy).not.toHaveBeenCalled();
      expect(r.rescheduled).toBe(0);
    }
  });

  it("задачи нет вовсе — ставит заново, ради этого механизм и существует", async () => {
    const r = await reconcileBurqSchedules(fakePrisma(null), NOW);
    expect(rescheduleSpy).toHaveBeenCalledTimes(1);
    expect(r.rescheduled).toBe(1);
  });

  it("считает просмотренных кандидатов независимо от решения", async () => {
    const r = await reconcileBurqSchedules(fakePrisma("DEAD_LETTER"), NOW);
    expect(r.scanned).toBe(1);
  });
});
