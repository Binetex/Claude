/**
 * ✨ у «Отправить» (throwaway prisma dev): ИИ пишет ответ клиенту на его последние сообщения, а
 * следующее нажатие просит другой вариант.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { DeepseekClient } from "@/integrations/deepseek/client";
import { suggestReply } from "./suggest";

const suffix = `suggest-${Date.now()}`;
const RECIP = "+13105557311";
let siteId = "";
let orderId = "";

function model(reply: string) {
  const complete = vi.fn(async () => ({ text: JSON.stringify({ reply_en: reply, intent: "other" }), model: "fake", latencyMs: 1 }));
  return { client: { complete } as unknown as DeepseekClient, complete };
}

afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("suggestReply", () => {
  it("отвечает на неотвеченные сообщения этой стороны; ещё раз — другой вариант", async () => {
    siteId = (await prisma.site.create({ data: { name: `SG ${suffix}`, shortName: "SG", platform: "WOOCOMMERCE" } })).id;
    orderId = (await prisma.order.create({
      data: {
        orderNumber: `SG-${suffix}`, site: { connect: { id: siteId } }, platform: "WOOCOMMERCE", source: "Test", orderStatus: "CONFIRMED",
        externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "11:00 - 15:00",
        senderName: "Anna", senderPhone: "+13105557310", recipientName: "Ann", recipientPhone: RECIP,
        addressLine: "1 Main St", city: "LA", zip: "90001", itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(100),
      },
    })).id;
    const comm = (direction: "INBOUND" | "OUTBOUND", messageText: string, minutesAgo: number) =>
      prisma.orderCommunication.create({
        data: { orderId, provider: "QUO", type: "SMS", direction, status: direction === "INBOUND" ? "RECEIVED" : "DELIVERED", externalPhone: RECIP, externalPhoneNormalized: RECIP, messageText, occurredAt: new Date(Date.now() - minutesAgo * 60_000) },
      });
    await comm("INBOUND", "hi, is it coming today?", 60);
    await comm("OUTBOUND", "Yes, today!", 50);
    await comm("INBOUND", "what is the eta", 5);

    const first = model("It's on the way and should arrive within your window.");
    expect(await suggestReply(prisma, { orderId, target: "RECIPIENT" }, { client: first.client })).toEqual({ ok: true, text: "It's on the way and should arrive within your window." });
    const [messages, opts] = first.complete.mock.calls[0] as unknown as [{ role: string; content: string }[], { temperature?: number }];
    const user = messages[messages.length - 1].content;
    expect(user).toContain("what is the eta");
    expect(opts.temperature).toBeUndefined();

    const again = model("We'll text you as soon as the courier picks it up.");
    expect(await suggestReply(prisma, { orderId, target: "RECIPIENT", avoid: ["It's on the way and should arrive within your window."] }, { client: again.client })).toMatchObject({ ok: true });
    const [m2, o2] = again.complete.mock.calls[0] as unknown as [{ role: string; content: string }[], { temperature?: number }];
    expect(m2[m2.length - 1].content).toContain("never reuse them");
    expect(o2.temperature).toBeGreaterThan(0.5);

    // Тот же текст, что уже был, — не новый вариант.
    expect(await suggestReply(prisma, { orderId, target: "RECIPIENT", avoid: ["Same text."] }, { client: model("Same text.").client })).toEqual({ ok: false, code: "no_reply" });
  });
});
