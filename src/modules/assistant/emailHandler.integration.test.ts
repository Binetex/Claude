/**
 * Ассистент отвечает на письма (29.09.2026) — на реальной БД (throwaway prisma dev). Модель
 * подменена, почтовый модуль замокан через fetch.
 *
 * Проверяется путь целиком: письмо клиента при включённом ассистенте идёт ему, а не простым
 * уведомлением; ответ модели становится разбором письма; в автоматическом режиме ответ уходит
 * письмом в ТОТ ЖЕ тред; «спасибо» не разбирается, но людям приходит уведомление.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";

process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { saveEmailFactoryToken } from "@/integrations/emailFactory/token";
import { ingestInboundEmails } from "@/integrations/emailFactory/ingest";
import { buildAssistantEmailHandler } from "./emailHandler";
import { ASSISTANT_EMAIL_EVENT } from "./events";

const suffix = `aiemail-${Date.now()}`;
const siteIds: string[] = [];
const orderIds: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function makeOrder(aiMode: "OFF" | "DRAFT" | "AUTO_SIMPLE", tag: string) {
  const site = await prisma.site.create({
    data: { name: `AI Email ${suffix}-${tag}`, shortName: `AE${tag}${suffix.slice(-4)}`, platform: "WOOCOMMERCE", emailFactoryDomain: `${tag}.example`, aiMode, aiDryRun: false },
  });
  siteIds.push(site.id);
  const order = await prisma.order.create({
    data: {
      orderNumber: `AE-${suffix}-${tag}`, site: { connect: { id: site.id } }, platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(),
      deliveryDate: new Date(Date.now() + 86_400_000), deliveryWindow: "11:00 - 15:00", windowFrom: 660, windowTo: 900,
      senderName: "Jorge Batarse", senderPhone: "+15551112222", senderEmail: `jorge-${tag}@example.com`,
      recipientName: "Amaris", recipientPhone: "+15553334444", addressLine: "1 Main St", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(115), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    },
  });
  orderIds.push(order.id);
  return { site, order };
}

async function inbound(orderId: string, from: string, text: string, tag: string) {
  return prisma.orderEmailMessage.create({
    data: { orderId, providerMessageId: `in-${suffix}-${tag}`, threadId: `thr-${suffix}-${tag}`, direction: "INBOUND", status: "RECEIVED", fromEmail: from, toEmail: `client@${tag}.example`, subject: "Re: Order", text, occurredAt: new Date() },
  });
}

const model = (reply: Record<string, unknown>) => ({
  complete: vi.fn(async () => ({ text: JSON.stringify({ intent: "delivery_time", important: false, needs_human: false, ready_time: null, new_delivery_date: null, confirmed_from: null, confirmed_until: null, ...reply }), model: "fake", latencyMs: 1 })),
});

beforeEach(async () => {
  fetchMock.mockReset();
  await saveEmailFactoryToken(prisma, "ef-token-for-tests-1234567890");
});

afterAll(async () => {
  await prisma.aiTurn.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.orderEmailMessage.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ eventType: ASSISTANT_EMAIL_EVENT }, { eventType: "telegram.notify", aggregateId: { in: orderIds } }] } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.integrationSecret.deleteMany({ where: { provider: "EMAIL_FACTORY" } });
  await prisma.$disconnect();
});

describe("письмо клиента при включённом ассистенте", () => {
  it("идёт ассистенту, а не простым уведомлением «клиент ответил»", async () => {
    const { order } = await makeOrder("DRAFT", "ing");
    fetchMock.mockResolvedValueOnce(json({ data: [{
      id: `ing-${suffix}`, threadId: `thr-ing-${suffix}`, direction: "INBOUND", status: "RECEIVED",
      from: order.senderEmail, to: "client@ing.example", subject: `Re: Order ${order.orderNumber}`, text: "Can you deliver after 5?", receivedAt: new Date().toISOString(),
    }] }));
    await ingestInboundEmails(prisma);

    const email = await prisma.orderEmailMessage.findUniqueOrThrow({ where: { providerMessageId: `ing-${suffix}` } });
    expect(email.orderId).toBe(order.id);
    expect(await prisma.outboxEvent.count({ where: { eventType: ASSISTANT_EMAIL_EVENT, aggregateId: email.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: "telegram.notify", aggregateId: order.id } })).toBe(0);
  });
});

describe("разбор письма", () => {
  it("в автоматическом режиме ответ уходит письмом в тот же тред, а время из письма — в окно заказа", async () => {
    const { order } = await makeOrder("AUTO_SIMPLE", "auto");
    const email = await inbound(order.id, order.senderEmail!, "Hi! Could you bring it after 5pm instead?\n\nSent from my iPhone", "auto");
    fetchMock.mockResolvedValueOnce(json({ data: { id: `out-${suffix}`, threadId: `thr-${suffix}-auto` } }));

    const client = model({ reply_en: "Hi Jorge, sure, we'll bring it after 5 🌸", ready_time: "after 5pm", confirmed_from: "17:00" });
    await buildAssistantEmailHandler(prisma, { client })({ payload: { emailMessageId: email.id } });

    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    expect(turn.status).toBe("SENT");
    expect(turn.communicationId).toBeNull();
    // Модель видела письмо без подписи приложения и знала, что отвечает письмом.
    const sent = (client.complete.mock.calls[0] as unknown[])[0] as { role: string; content: string }[];
    expect(sent[1].content).toContain("This customer wrote an EMAIL");
    expect(sent[1].content).not.toContain("Sent from my iPhone");
    // Ответ — в тред входящего письма, а не новым письмом.
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/threads/thr-${suffix}-auto/reply`);
    const out = await prisma.orderEmailMessage.findFirstOrThrow({ where: { orderId: order.id, direction: "OUTBOUND" } });
    expect(out.status).toBe("SENT");
    expect(out.text).toBe("Hi Jorge, sure, we'll bring it after 5 🌸");
    expect(out.sendKey).toBe(`ai-turn:${turn.id}`);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { windowFrom: true, windowTo: true } });
    expect(after).toEqual({ windowFrom: 17 * 60, windowTo: 21 * 60 });
  });

  it("в режиме черновиков ответ ждёт человека и письмом не уходит", async () => {
    const { order } = await makeOrder("DRAFT", "draft");
    const email = await inbound(order.id, order.senderEmail!, "Where is my order?", "draft");
    await buildAssistantEmailHandler(prisma, { client: model({ reply_en: "Let me check on it right now.", needs_human: true }) })({ payload: { emailMessageId: email.id } });

    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    expect(turn.status).toBe("DRAFT");
    expect(turn.replyText).toBe("Let me check on it right now.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("«спасибо» не разбирается, но людям уходит уведомление, что клиент написал", async () => {
    const { order } = await makeOrder("AUTO_SIMPLE", "thanks");
    const email = await inbound(order.id, order.senderEmail!, "Thank you!", "thanks");
    const client = model({ reply_en: "x" });
    await buildAssistantEmailHandler(prisma, { client })({ payload: { emailMessageId: email.id } });

    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    expect(turn.status).toBe("SKIPPED");
    expect(client.complete).not.toHaveBeenCalled();
    expect(await prisma.outboxEvent.count({ where: { eventType: "telegram.notify", aggregateId: order.id } })).toBe(1);
  });

  it("повтор обработчика второго разбора не создаёт", async () => {
    const { order } = await makeOrder("DRAFT", "twice");
    const email = await inbound(order.id, order.senderEmail!, "Can you deliver tomorrow instead?", "twice");
    const handler = buildAssistantEmailHandler(prisma, { client: model({ reply_en: "Sure, we'll bring it tomorrow then 🌸" }) });
    await handler({ payload: { emailMessageId: email.id } });
    await handler({ payload: { emailMessageId: email.id } });
    expect(await prisma.aiTurn.count({ where: { emailMessageId: email.id } })).toBe(1);
  });
});
