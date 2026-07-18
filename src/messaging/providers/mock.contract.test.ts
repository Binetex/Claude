import { describe, it, expect } from "vitest";
import { createMockProviders, MockMessageProvider } from "./mock";
import { assertMessageProviderContract } from "../contract/provider.contract";
import type { MessageChannel } from "../types";

const addr: Record<MessageChannel, string> = {
  SMS: "+15551112222",
  EMAIL: "buyer@example.com",
  TELEGRAM: "tg-1",
  PUSH: "push-token-1",
};

describe("MockMessageProvider — соответствие контракту провайдера (все каналы)", () => {
  const providers = createMockProviders();
  for (const channel of ["SMS", "EMAIL", "TELEGRAM", "PUSH"] as const) {
    it(`${channel} проходит контракт`, async () => {
      await assertMessageProviderContract(providers[channel], addr[channel]);
    });
  }

  it("возвращает deliveryStatus 'sent' и записывает отправку", async () => {
    const p = new MockMessageProvider("SMS");
    const res = await p.send({ channel: "SMS", to: "+1", subject: null, body: "x" }, {
      channel: "SMS", to: "+1", templateId: "order.ready", vars: {}, idempotencyKey: "k",
    });
    expect(res.deliveryStatus).toBe("sent");
    expect(p.sent).toHaveLength(1);
  });
});
