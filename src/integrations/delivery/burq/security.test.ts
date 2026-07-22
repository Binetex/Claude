import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBurqDraftCreate, type DraftContext, type DraftCreatePort } from "./draftHandler";
import { createMockBurqClient, __resetMockBurqStore } from "./client";
import { parseBurqWebhook } from "./webhook";

/**
 * Security: чувствительная ссылка checkout_url (доступ курьера к оформлению доставки) НЕ должна
 * протекать в логи, в payload outbox-задач или в нормализованное webhook-событие. Она хранится
 * только на строке Delivery (admin-only) и отдаётся лишь внутри админки.
 */
function makeCtx(): DraftContext {
  return {
    order: {
      id: "o1",
      orderStatus: "AWAITING_COURIER",
      deliveryDate: null,
      scheduleVersion: 0,
      siteAutoCreateEnabled: true,
      dropoff: { recipientName: "R", recipientPhone: "+13105550198", addressLine: "1 A St", city: "SM", recipientState: "CA", zip: "90401" },
    },
    floristId: "flo_1",
    pickup: {
      locationName: "M", contactName: "F", contactPhone: "+13105551111",
      addressLine: "2 B St", city: "LA", state: "CA", zip: "90013", isActive: true,
    },
    hasCurrentDraft: false,
    nextAttemptNumber: 1,
  };
}

describe("checkout_url не протекает", () => {
  beforeEach(() => __resetMockBurqStore());

  it("логи хендлера создания draft не содержат checkout_url", async () => {
    const logCalls: string[] = [];
    const log = (event: string, extra?: Record<string, unknown>) => {
      logCalls.push(JSON.stringify({ event, ...(extra ?? {}) }));
    };
    const port: DraftCreatePort = {
      loadContext: vi.fn().mockResolvedValue(makeCtx()),
      markIntent: vi.fn(),
      persistDraft: vi.fn(),
    };
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port, log }, { orderId: "o1", scheduleVersion: 0 });
    expect(res.outcome).toBe("created");
    for (const line of logCalls) {
      expect(line.toLowerCase()).not.toContain("checkout");
    }
  });

  it("persistDraft получает checkoutUrl (для БД), но log — нет", async () => {
    // checkoutUrl обязан дойти до persistDraft (сохраняется на Delivery), это не утечка.
    const port: DraftCreatePort = {
      loadContext: vi.fn().mockResolvedValue(makeCtx()),
      markIntent: vi.fn(),
      persistDraft: vi.fn(),
    };
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId: "o1", scheduleVersion: 0 });
    const arg = (port.persistDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.checkoutUrl).toContain("checkout"); // дошло до слоя БД
  });

  it("нормализованное webhook-событие не содержит поля checkout_url", () => {
    const ev = parseBurqWebhook({
      event_id: "e1",
      data: { id: "ord1", status: "delivered", checkout_url: "https://secret/checkout/x" },
    });
    expect(JSON.stringify(ev)).not.toContain("checkout");
  });
});
