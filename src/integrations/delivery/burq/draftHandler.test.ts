import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBurqDraftCreate, externalCreateIdempotencyKey, type DraftContext, type DraftCreatePort } from "./draftHandler";
import { createMockBurqClient, __resetMockBurqStore } from "./client";

const pickup = {
  locationName: "Main",
  contactName: "Jane",
  contactPhone: "+13105551111",
  addressLine: "2 B St",
  city: "LA",
  state: "CA",
  zip: "90013",
  isActive: true,
};

function makeCtx(over: Partial<DraftContext> = {}): DraftContext {
  return {
    order: {
      id: "o1",
      orderStatus: "AWAITING_COURIER",
      deliveryDate: null,
      scheduleVersion: 1,
      siteAutoCreateEnabled: true,
      dropoff: {
        recipientName: "R",
        recipientPhone: "+13105550198",
        addressLine: "1 A St",
        city: "Santa Monica",
        recipientState: "CA",
        zip: "90401",
      },
    },
    floristId: "flo_1",
    pickup,
    hasCurrentDraft: false,
    nextAttemptNumber: 1,
    ...over,
  };
}

function makePort(ctx: DraftContext | null): DraftCreatePort {
  return {
    loadContext: vi.fn().mockResolvedValue(ctx),
    markIntent: vi.fn().mockResolvedValue(undefined),
    persistDraft: vi.fn().mockResolvedValue(undefined),
  };
}

describe("handleBurqDraftCreate", () => {
  beforeEach(() => __resetMockBurqStore());

  it("создаёт черновик и персистит Delivery", async () => {
    const port = makePort(makeCtx());
    const client = createMockBurqClient();
    const res = await handleBurqDraftCreate({ client, port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res.outcome).toBe("created");
    expect(port.persistDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", floristId: "flo_1", attemptNumber: 1, referenceId: "o1:a1", rawStatus: "request" })
    );
  });

  it("устаревшая задача (версия меньше текущей) игнорируется", async () => {
    const port = makePort(makeCtx({ order: { ...makeCtx().order, scheduleVersion: 3 } }));
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res.outcome).toBe("stale");
    expect(port.persistDraft).not.toHaveBeenCalled();
  });

  it("нет флориста → waiting (WAITING_FOR_FLORIST), без создания", async () => {
    const port = makePort(makeCtx({ floristId: null }));
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res).toEqual({ outcome: "waiting", reason: "no_florist" });
    expect(port.markIntent).toHaveBeenCalledWith("o1", "WAITING_FOR_FLORIST", "no_florist");
    expect(port.persistDraft).not.toHaveBeenCalled();
  });

  it("pickup невалиден → waiting pickup_invalid", async () => {
    const port = makePort(makeCtx({ pickup: { ...pickup, state: "ZZ" } }));
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res).toEqual({ outcome: "waiting", reason: "pickup_invalid" });
  });

  it("сайт выключен → skipped site_disabled", async () => {
    const port = makePort(makeCtx({ order: { ...makeCtx().order, siteAutoCreateEnabled: false } }));
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res).toEqual({ outcome: "skipped", reason: "site_disabled" });
    expect(port.markIntent).toHaveBeenCalledWith("o1", "SKIPPED", "site_disabled");
  });

  it("уже есть черновик → skipped draft_exists", async () => {
    const port = makePort(makeCtx({ hasCurrentDraft: true }));
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res).toEqual({ outcome: "skipped", reason: "draft_exists" });
  });

  it("заказ не найден → order_missing", async () => {
    const port = makePort(null);
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 1 });
    expect(res).toEqual({ outcome: "order_missing" });
  });

  it("вторая попытка использует attemptNumber в idempotency-key", () => {
    expect(externalCreateIdempotencyKey("o1", 2)).toBe("burq:create:o1:2");
  });

  it("ошибка Burq пробрасывается (для ретрая outbox)", async () => {
    const port = makePort(makeCtx());
    const client = { mode: "mock" as const, createDraft: vi.fn().mockRejectedValue(new Error("boom")), getOrder: vi.fn(), deleteOrder: vi.fn() };
    await expect(handleBurqDraftCreate({ client, port }, { orderId: "o1", scheduleVersion: 1 })).rejects.toThrow("boom");
    expect(port.persistDraft).not.toHaveBeenCalled();
  });
});
