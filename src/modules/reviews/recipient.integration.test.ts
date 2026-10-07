/**
 * Отзыв у ПОЛУЧАТЕЛЯ букета. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, на чём запрос получателю молча работал бы как запрос заказчику: свой запрос на
 * заказ рядом с запросом заказчика; ссылка уходит получателю своим текстом и без письма (почты
 * получателя в заказе нет); «ответил» и «игнорирует» считаются по номеру получателя, а не
 * заказчика; колл-центр получает задачу один раз.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const smsCalls: { target: string; text: string; replyToInbound?: boolean }[] = [];
let smsResult: { ok: true; communicationId: string; status: "SENT"; duplicate: false } | { ok: false; code: string } = {
  ok: true, communicationId: "c", status: "SENT", duplicate: false,
};
vi.mock("@/integrations/quo/send", () => ({
  sendOrderSms: vi.fn(async (_db: unknown, _client: unknown, input: { target: string; text: string; replyToInbound?: boolean }) => {
    smsCalls.push(input);
    return smsResult;
  }),
}));
const emailSend = vi.fn();
vi.mock("@/modules/messaging/channels/email", () => ({ createEmailChannelSender: () => ({ send: emailSend }) }));

import { prisma } from "@/lib/db";
import { createReviewRequest, recordLinkSent } from "./requests";
import { askRecipientReview } from "./recipient";
import { sendReviewLink } from "./sendLink";
import { noteReviewReply } from "./reply";
import { processIgnoredRequests } from "./deadlines";

const RUN = `rrcp-${Date.now()}`;
const N = String(Date.now()).slice(-3);
let siteId = "";
let actor = { userId: "" };
let seq = 0;

/** Свои номера на заказ: ответ ищется по телефону, общий номер связал бы разные запросы. */
async function makeOrder(opts: { samePhone?: boolean } = {}) {
  seq += 1;
  const sender = `+1310${N}${String(seq).padStart(2, "0")}1`;
  const recipient = opts.samePhone ? sender : `+1310${N}${String(seq).padStart(2, "0")}2`;
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${seq}`,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-10-01T10:00:00Z"),
      deliveryDate: new Date("2026-10-02T00:00:00Z"),
      deliveryWindow: "12:00 - 16:00",
      senderName: "John",
      senderPhone: sender,
      senderEmail: `${RUN}-${seq}@example.com`,
      recipientName: "Maria",
      recipientPhone: recipient,
      addressLine: "1 Main St",
      city: "LA",
      zip: "90210",
      itemsTotal: "100.00",
      customerTotal: "100.00",
    },
  });
  return { id: order.id, sender, recipient };
}

async function inbound(phone: string, at = new Date()) {
  return prisma.orderCommunication.create({
    data: {
      provider: "QUO", type: "SMS", direction: "INBOUND", status: "RECEIVED",
      externalPhone: phone, externalPhoneNormalized: phone, messageText: "ok", occurredAt: at,
    },
  });
}

const tasks = (orderId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: orderId, idempotencyKey: { startsWith: "telegram:order.ask_review_recipient:" } } });

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "RCP", platform: "SHOPIFY", connectionStatus: "CONNECTED", reviewUrl: "https://g.page/r/shop/review" },
  });
  siteId = site.id;
  const user = await prisma.user.create({ data: { name: "Владелец", email: `${RUN}@example.com`, role: "OWNER", passwordHash: "x" } });
  actor = { userId: user.id };
});

beforeEach(() => {
  smsCalls.length = 0;
  emailSend.mockReset();
  smsResult = { ok: true, communicationId: "c", status: "SENT", duplicate: false };
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { siteId }, select: { id: true } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orders.map((o) => o.id) } } }).catch(() => {});
  await prisma.orderCommunication.deleteMany({ where: { externalPhoneNormalized: { startsWith: `+1310${N}` } } }).catch(() => {});
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: actor.userId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("запрос отзыва у получателя", () => {
  it("свой запрос рядом с запросом заказчика; повторное нажатие второго не заводит", async () => {
    const o = await makeOrder();
    const customer = await createReviewRequest(prisma, o.id, actor);
    const first = await askRecipientReview(prisma, o.id, actor);
    const again = await askRecipientReview(prisma, o.id, actor);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toEqual({ ok: true, id: (first as { id: string }).id, created: false });
    const rows = await prisma.orderReviewRequest.findMany({ where: { orderId: o.id }, select: { id: true, party: true } });
    expect(rows.map((r) => r.party).sort()).toEqual(["CUSTOMER", "RECIPIENT"]);
    expect(rows.find((r) => r.party === "CUSTOMER")?.id).toBe(customer.id);
    // Колл-центру — одна задача, а не по одной на нажатие.
    expect(await tasks(o.id)).toHaveLength(1);
  });

  it("один номер на двоих — получатель и есть заказчик: отдельного запроса нет", async () => {
    const o = await makeOrder({ samePhone: true });
    expect(await askRecipientReview(prisma, o.id, actor)).toMatchObject({ ok: false });
    expect(await prisma.orderReviewRequest.count({ where: { orderId: o.id } })).toBe(0);
    expect(await tasks(o.id)).toHaveLength(0);
  });
});

describe("ссылка получателю", () => {
  it("уходит получателю его текстом — без «thank you for your order»", async () => {
    const o = await makeOrder();
    const r = await askRecipientReview(prisma, o.id, actor);
    const id = (r as { id: string }).id;

    expect(await sendReviewLink(prisma, { requestId: id, kind: "ASK", sendKey: `${id}-ask`, actor })).toEqual({ ok: true, channel: "SMS" });
    expect(smsCalls[0]).toMatchObject({ target: "RECIPIENT", replyToInbound: false });
    expect(smsCalls[0].text).toMatch(/^Hi Maria, we hope you loved your flowers/);
    expect(smsCalls[0].text).toContain("https://g.page/r/shop/review");
  });

  it("получатель сам нам писал — «сюрприз» отправку не держит", async () => {
    const o = await makeOrder();
    await inbound(o.recipient);
    const id = ((await askRecipientReview(prisma, o.id, actor)) as { id: string }).id;
    await sendReviewLink(prisma, { requestId: id, kind: "ASK", sendKey: `${id}-ask2`, actor });
    expect(smsCalls[0]).toMatchObject({ target: "RECIPIENT", replyToInbound: true });
  });

  it("SMS не ушла — письма нет: почта в заказе принадлежит заказчику", async () => {
    smsResult = { ok: false, code: "store_quo_disabled" };
    const o = await makeOrder();
    const id = ((await askRecipientReview(prisma, o.id, actor)) as { id: string }).id;
    const res = await sendReviewLink(prisma, { requestId: id, kind: "ASK", sendKey: `${id}-ask3`, actor });
    expect(res).toMatchObject({ ok: false, code: "store_quo_disabled" });
    expect(emailSend).not.toHaveBeenCalled();
  });
});

describe("ответ и молчание считаются по номеру получателя", () => {
  async function linkSentToRecipient(hoursAgo = 30) {
    const o = await makeOrder();
    const id = ((await askRecipientReview(prisma, o.id, actor)) as { id: string }).id;
    await recordLinkSent(prisma, id, "SMS", actor);
    await prisma.orderReviewRequest.update({ where: { id }, data: { linkSentAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
    return { ...o, requestId: id };
  }
  const status = async (id: string) => (await prisma.orderReviewRequest.findUniqueOrThrow({ where: { id } })).status;

  it("получатель ответил — запрос получателю вернулся в работу", async () => {
    const o = await linkSentToRecipient(1);
    const msg = await inbound(o.recipient);
    expect(await noteReviewReply(prisma, msg.id)).toBe(true);
    expect(await status(o.requestId)).toBe("REPLIED");
  });

  it("ответ заказчика за ответ получателя не считается", async () => {
    const o = await linkSentToRecipient(1);
    const msg = await inbound(o.sender);
    expect(await noteReviewReply(prisma, msg.id)).toBe(false);
    expect(await status(o.requestId)).toBe("LINK_SENT");
  });

  it("сутки молчания получателя — «игнорирует», даже если заказчик писал", async () => {
    const o = await linkSentToRecipient();
    await inbound(o.sender, new Date(Date.now() - 3_600_000));
    await processIgnoredRequests(prisma);
    expect(await status(o.requestId)).toBe("IGNORING");
  });
});
