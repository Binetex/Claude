import { describe, it, expect, vi } from "vitest";
import { computeDraftAvailableAt, draftCreateIdempotencyKey, scheduleBurqDraftForOrder, BURQ_DRAFT_CREATE_EVENT } from "./schedule";

describe("computeDraftAvailableAt", () => {
  it("будущая доставка → 04:00 локального дня доставки (LA летом → 11:00Z)", () => {
    const deliveryDate = new Date("2026-07-20T00:00:00.000Z"); // UTC-полночь локального дня
    const now = new Date("2026-07-18T09:00:00.000Z");
    const at = computeDraftAvailableAt(deliveryDate, "04:00", "America/Los_Angeles", now);
    expect(at.toISOString()).toBe("2026-07-20T11:00:00.000Z");
  });

  it("сегодняшняя/просроченная доставка → now", () => {
    const deliveryDate = new Date("2026-07-18T00:00:00.000Z");
    const now = new Date("2026-07-18T20:00:00.000Z"); // уже позже 04:00 локального
    const at = computeDraftAvailableAt(deliveryDate, "04:00", "America/Los_Angeles", now);
    expect(at.getTime()).toBe(now.getTime());
  });

  it("кастомное время создания учитывается", () => {
    const deliveryDate = new Date("2026-07-20T00:00:00.000Z");
    const now = new Date("2026-07-18T09:00:00.000Z");
    const at = computeDraftAvailableAt(deliveryDate, "06:30", "America/Los_Angeles", now);
    // 06:30 PDT (UTC-7) → 13:30Z
    expect(at.toISOString()).toBe("2026-07-20T13:30:00.000Z");
  });
});

describe("draftCreateIdempotencyKey", () => {
  it("включает orderId и версию расписания", () => {
    expect(draftCreateIdempotencyKey("o1", 2)).toBe("burq:draft:create:o1:v2");
  });
});

describe("scheduleBurqDraftForOrder", () => {
  it("ставит отложенную задачу с корректным ключом/типом/payload", async () => {
    const enqueue = vi.fn().mockResolvedValue({ created: true });
    const res = await scheduleBurqDraftForOrder(
      { enqueue },
      {
        orderId: "o1",
        deliveryDate: new Date("2026-07-20T00:00:00.000Z"),
        timezone: "America/Los_Angeles",
        creationLocalTime: "04:00",
        scheduleVersion: 1,
        now: new Date("2026-07-18T09:00:00.000Z"),
      }
    );
    expect(res.created).toBe(true);
    expect(res.availableAt.toISOString()).toBe("2026-07-20T11:00:00.000Z");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: BURQ_DRAFT_CREATE_EVENT,
        aggregateId: "o1",
        idempotencyKey: "burq:draft:create:o1:v1",
        payload: { orderId: "o1", scheduleVersion: 1 },
      })
    );
  });
});
