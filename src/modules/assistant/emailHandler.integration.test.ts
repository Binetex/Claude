/**
 * Ассистент отвечает на письма (29.09.2026) — на реальной БД (throwaway prisma dev). Модель
 * подменена, почтовый модуль замокан через fetch. Telegram в тестовой БД не настроен, поэтому
 * черновик людям «не доходит» — ровно тот случай, когда письмо обязано уйти уведомлением.
 *
 * Проверяется путь целиком: письмо клиента при включённом ассистенте идёт ему, а не простым
 * уведомлением; ответ модели становится разбором письма; в автоматическом режиме ответ уходит
 * письмом в ТОТ ЖЕ тред; «спасибо» не разбирается, но людям приходит уведомление; письма подряд
 * разбираются одним разом; автоответчикам не отвечаем; ответ и письмо правила уходят тому, кому
 * написаны.
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
import { createEmailFactoryChannelSender } from "@/modules/messaging/channels/emailFactory";
import { buildAssistantEmailHandler } from "./emailHandler";
import { sendAssistantReply } from "./deliver";
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

async function inbound(orderId: string, from: string, text: string, tag: string, extra: { subject?: string; at?: Date } = {}) {
  return prisma.orderEmailMessage.create({
    data: { orderId, providerMessageId: `in-${suffix}-${tag}`, threadId: `thr-${suffix}-${tag}`, direction: "INBOUND", status: "RECEIVED", fromEmail: from, toEmail: `client@${tag}.example`, subject: extra.subject ?? "Re: Order", text, occurredAt: extra.at ?? new Date() },
  });
}

/** Уведомления заказа в очереди Telegram — их типы и цитаты. */
async function notices(orderId: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { eventType: "telegram.notify", aggregateId: orderId }, select: { payload: true } });
  return rows.map((r) => r.payload as { type: string; context: { quote?: string } });
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
    expect(sent[1].content).toContain("This message came as an EMAIL");
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
    // Черновик людям не показан (Telegram не настроен) — письмо не остаётся только в карточке.
    expect((await notices(order.id)).map((n) => n.type)).toEqual(["customer.email_reply"]);
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

  it("автоответ «я в отпуске» не разбирается: модели нет, ответа нет, людям — уведомление", async () => {
    const { order } = await makeOrder("AUTO_SIMPLE", "ooo");
    const email = await inbound(order.id, order.senderEmail!, "I am currently out of the office until Monday.", "ooo", { subject: "Automatic reply: Re: Order" });
    const client = model({ reply_en: "Enjoy your time off!" });
    await buildAssistantEmailHandler(prisma, { client })({ payload: { emailMessageId: email.id } });

    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    expect([turn.status, turn.skipReason]).toEqual(["SKIPPED", "auto_reply"]);
    expect(client.complete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await notices(order.id)).map((n) => n.type)).toEqual(["customer.email_reply"]);
  });

  it("перенос просит не заказчик — заказ не двигаем и сами не обещаем: ответ черновиком человеку", async () => {
    const { order } = await makeOrder("AUTO_SIMPLE", "stranger");
    const email = await inbound(order.id, `husband-${suffix}@example.com`, "She won't be home today, can you bring it tomorrow?", "stranger");
    await buildAssistantEmailHandler(prisma, { client: model({ intent: "delivery_date_change", reply_en: "Hi, sure, we'll bring it tomorrow 🌸", new_delivery_date: "2099-01-02" }) })({ payload: { emailMessageId: email.id } });

    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    expect(turn.status).toBe("DRAFT");
    expect(turn.needsHuman).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { deliveryDate: true } });
    expect(after.deliveryDate).toEqual(order.deliveryDate);
  });

  it("просьба позвонить из письма — сразу владельцу и колл-центру, как у SMS", async () => {
    const { order } = await makeOrder("DRAFT", "call");
    const email = await inbound(order.id, order.senderEmail!, "Please call me about the delivery.", "call");
    await buildAssistantEmailHandler(prisma, { client: model({ intent: "call_request", reply_en: "Sure, we'll call you shortly." }) })({ payload: { emailMessageId: email.id } });

    const types = (await notices(order.id)).map((n) => n.type);
    expect(types).toContain("customer.call_request");
    expect(types).toContain("customer.call_request_cc");
  });
});

describe("письма подряд", () => {
  it("«спасибо» вдогонку не отменяет ответ на сам вопрос", async () => {
    const { order } = await makeOrder("DRAFT", "qthx");
    const t0 = new Date(Date.now() - 60_000);
    const question = await inbound(order.id, order.senderEmail!, "Can you deliver after 5?", "qthx-q", { at: t0 });
    await inbound(order.id, order.senderEmail!, "Thank you!", "qthx-t", { at: new Date(t0.getTime() + 30_000) });
    const client = model({ reply_en: "Sure, after 5 works 🌸" });
    await buildAssistantEmailHandler(prisma, { client })({ payload: { emailMessageId: question.id } });

    expect((await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: question.id } })).status).toBe("DRAFT");
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("два письма подряд — один разбор на оба, и людям видны оба", async () => {
    const { order } = await makeOrder("DRAFT", "pair");
    const t0 = new Date(Date.now() - 60_000);
    const first = await inbound(order.id, order.senderEmail!, "Can you deliver after 5?", "pair-a", { at: t0 });
    const second = await inbound(order.id, order.senderEmail!, "Also the gate code is 4411.", "pair-b", { at: new Date(t0.getTime() + 30_000) });
    const client = model({ reply_en: "Got it, after 5, and thanks for the gate code 🌸" });
    const handler = buildAssistantEmailHandler(prisma, { client });
    await handler({ payload: { emailMessageId: first.id } });
    await handler({ payload: { emailMessageId: second.id } });

    expect((await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: first.id } })).skipReason).toBe("superseded");
    expect(client.complete).toHaveBeenCalledTimes(1);
    const sent = (client.complete.mock.calls[0] as unknown[])[0] as { role: string; content: string }[];
    expect(sent[1].content).toContain("Can you deliver after 5?\nAlso the gate code is 4411.");
    const [notice] = await notices(order.id);
    expect(notice.context.quote).toContain("Can you deliver after 5?");
    expect(notice.context.quote).toContain("gate code is 4411");
  });

  it("письмо другого человека не отменяет ответ заказчику", async () => {
    const { order } = await makeOrder("DRAFT", "other");
    const t0 = new Date(Date.now() - 60_000);
    const mine = await inbound(order.id, order.senderEmail!, "Can you deliver after 5?", "other-a", { at: t0 });
    await inbound(order.id, `friend-${suffix}@example.com`, "Is the order on its way?", "other-b", { at: new Date(t0.getTime() + 30_000) });
    await buildAssistantEmailHandler(prisma, { client: model({ reply_en: "Sure, after 5 works 🌸" }) })({ payload: { emailMessageId: mine.id } });

    expect((await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: mine.id } })).status).toBe("DRAFT");
  });
});

describe("кому уходит письмо", () => {
  it("ответ ассистента — на своё письмо, даже если потом по заказу написал другой человек", async () => {
    const { order } = await makeOrder("DRAFT", "own");
    const email = await inbound(order.id, order.senderEmail!, "Can you deliver after 5?", "own-a", { at: new Date(Date.now() - 60_000) });
    await buildAssistantEmailHandler(prisma, { client: model({ reply_en: "Hi Jorge, sure, after 5 works 🌸" }) })({ payload: { emailMessageId: email.id } });
    const turn = await prisma.aiTurn.findUniqueOrThrow({ where: { emailMessageId: email.id } });
    // Пока черновик ждал человека, в другом треде написал другой человек.
    await inbound(order.id, `stranger-${suffix}@example.com`, "Hello?", "own-b");

    fetchMock.mockResolvedValueOnce(json({ data: { id: `out-own-${suffix}`, threadId: `thr-${suffix}-own-a` } }));
    expect(await sendAssistantReply(prisma, turn.id)).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/threads/thr-${suffix}-own-a/reply`);
    const out = await prisma.orderEmailMessage.findFirstOrThrow({ where: { orderId: order.id, direction: "OUTBOUND" } });
    expect(out.toEmail).toBe(order.senderEmail);
  });

  it("письмо правила — заказчику, а не тому, кто последним писал по заказу", async () => {
    const { site, order } = await makeOrder("OFF", "rule");
    await inbound(order.id, `friend-${suffix}@example.com`, "Is it on its way?", "rule-friend");
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ domain: "rule.example", email: "client@rule.example", status: "READY" }] }))
      .mockResolvedValueOnce(json({ data: { id: `out-rule-${suffix}`, threadId: `thr-new-${suffix}` } }));

    const res = await createEmailFactoryChannelSender(prisma).send({
      prisma, orderId: order.id, siteId: site.id, recipientType: "CUSTOMER", phoneNormalized: null,
      emailNormalized: order.senderEmail, triggerType: "ORDER_PAID", emailTemplateIdOverride: null,
      text: "Hi Jorge, we couldn't reach the recipient.", vars: {}, idempotencyKey: `rule-${suffix}:a0`,
    });

    expect(res.ok).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/v1/messages");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).to).toBe(order.senderEmail);
  });
});

describe("очередь к ассистенту", () => {
  it("письма одного опроса встают в очередь от старых к новым, даже если провайдер отдал наоборот", async () => {
    const { order } = await makeOrder("DRAFT", "ord");
    const t0 = Date.now() - 120_000;
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const base = { direction: "INBOUND", status: "RECEIVED", from: order.senderEmail, to: "client@ord.example", subject: `Re: Order ${order.orderNumber}` };
    fetchMock.mockResolvedValueOnce(json({ data: [
      { ...base, id: `ord-new-${suffix}`, threadId: `thr-ord-${suffix}`, text: "Also the gate code is 4411.", receivedAt: at(30_000) },
      { ...base, id: `ord-old-${suffix}`, threadId: `thr-ord-${suffix}`, text: "Can you deliver after 5?", receivedAt: at(0) },
    ] }));
    await ingestInboundEmails(prisma);

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: ASSISTANT_EMAIL_EVENT, aggregateId: { in: (await prisma.orderEmailMessage.findMany({ where: { orderId: order.id }, select: { id: true } })).map((e) => e.id) } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      select: { aggregateId: true },
    });
    const old = await prisma.orderEmailMessage.findUniqueOrThrow({ where: { providerMessageId: `ord-old-${suffix}` } });
    expect(events.map((e) => e.aggregateId)[0]).toBe(old.id);
    expect(events).toHaveLength(2);
  });
});
