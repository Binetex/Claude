import { describe, it, expect, beforeEach } from "vitest";
import { createMockBurqClient, __resetMockBurqStore, BurqApiError } from "./client";
import { buildBurqDraftRequest, type DraftOrderInput, type PickupInput } from "./request";

const order: DraftOrderInput = {
  recipientName: "R",
  recipientPhone: "+13105550198",
  addressLine: "1 A St",
  city: "Santa Monica",
  recipientState: "CA",
  zip: "90401",
};
const pickup: PickupInput = {
  locationName: "M",
  contactName: "F",
  contactPhone: "+13105551111",
  addressLine: "2 B St",
  city: "LA",
  state: "CA",
  zip: "90013",
};

describe("mock BurqClient — draft-first", () => {
  beforeEach(() => __resetMockBurqStore());

  it("createDraft → неинициированный `request` + checkoutUrl + testMode", async () => {
    const c = createMockBurqClient();
    const req = buildBurqDraftRequest("o1:a1", order, pickup);
    const res = await c.createDraft(req, "burq:create:o1:1");
    expect(res.status).toBe("request");
    expect(res.checkoutUrl).toContain(res.id);
    expect(res.externalOrderRef).toBe("o1:a1");
    expect(res.testMode).toBe(true);
  });

  it("getOrder возвращает созданный черновик", async () => {
    const c = createMockBurqClient();
    const res = await c.createDraft(buildBurqDraftRequest("o1:a1", order, pickup), "k1");
    const got = await c.getOrder(res.id);
    expect(got.id).toBe(res.id);
  });

  it("deleteOrder удаляет неинициированный черновик", async () => {
    const c = createMockBurqClient();
    const res = await c.createDraft(buildBurqDraftRequest("o1:a1", order, pickup), "k1");
    await c.deleteOrder(res.id);
    await expect(c.getOrder(res.id)).rejects.toBeInstanceOf(BurqApiError);
  });

  it("getOrder несуществующего → 404", async () => {
    const c = createMockBurqClient();
    await expect(c.getOrder("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("повтор с тем же idempotency-key возвращает тот же черновик (не плодит доставки)", async () => {
    const c = createMockBurqClient();
    const req = buildBurqDraftRequest("o1:a1", order, pickup);
    const a = await c.createDraft(req, "burq:create:o1:1");
    const b = await c.createDraft(req, "burq:create:o1:1");
    expect(b.id).toBe(a.id);
  });
});
