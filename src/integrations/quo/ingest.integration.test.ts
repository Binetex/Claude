import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { ingestQuoEvent, QuoIngestRetryableError } from "./ingest";
import { parseQuoWebhook } from "./envelope";
import type { NormalizedQuoEvent } from "./types";

/** Интеграционные тесты приёма QUO-события на реальной БД (локальный DATABASE_URL). Серийно. */
const suffix = `quo-${Date.now()}`;
let siteId: string;
const orderIds: string[] = [];
const STORE = "+13105550000";
const PN_ID = `PN-${Date.now()}`;
let seq = 4000;
const uniquePhone = () => `+1310555${(seq++).toString().padStart(4, "0")}`;

async function makeOrder(opts: { senderPhone: string; recipientPhone: string; deliveryDate: Date; orderStatus?: string }): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#QUO-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate: opts.deliveryDate,
      deliveryWindow: "12:00 – 16:00",
      senderName: "Buyer",
      senderPhone: opts.senderPhone,
      recipientName: "Recipient",
      recipientPhone: opts.recipientPhone,
      addressLine: "1 A St",
      city: "Santa Monica",
      zip: "90401",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      orderStatus: (opts.orderStatus ?? "CONFIRMED") as never,
    },
    select: { id: true },
  });
  orderIds.push(order.id);
  return order.id;
}

function ev(type: string, object: Record<string, unknown>, id: string): NormalizedQuoEvent {
  const parsed = parseQuoWebhook({ id, object: "event", apiVersion: "v3", createdAt: new Date().toISOString(), type, data: { object } });
  if (!parsed) throw new Error(`unparseable ${type}`);
  return parsed;
}

beforeAll(async () => {
  const site = await prisma.site.create({ data: { name: `QUO Site ${suffix}`, shortName: "QUO", platform: "WOOCOMMERCE", quoPhoneNumberId: PN_ID, quoPhoneNumber: STORE } });
  siteId = site.id;
});
afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { storePhone: STORE }, { providerPhoneNumberId: PN_ID }] } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

const today = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

describe("ingestQuoEvent — привязка и идемпотентность", () => {
  it("входящее SMS от покупателя → привязка к заказу, partyRole CUSTOMER (§16.1)", async () => {
    const cust = uniquePhone();
    const orderId = await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    const res = await ingestQuoEvent(prisma, ev("message.received", { id: "AC_b1", from: cust, to: [STORE], direction: "incoming", body: "Hi" }, "EV_b1"));
    expect(res).toMatchObject({ outcome: "created", orderId });
    const comm = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: "EV_b1" } } });
    expect(comm).toMatchObject({ orderId, partyRole: "CUSTOMER", type: "SMS", direction: "INBOUND", status: "RECEIVED" });
  });

  it("входящее SMS от получателя → partyRole RECIPIENT (§16.2)", async () => {
    const recip = uniquePhone();
    const orderId = await makeOrder({ senderPhone: uniquePhone(), recipientPhone: recip, deliveryDate: today() });
    await ingestQuoEvent(prisma, ev("message.received", { id: "AC_r1", from: recip, to: [STORE], direction: "incoming", body: "On my way?" }, "EV_r1"));
    const comm = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: "EV_r1" } } });
    expect(comm).toMatchObject({ orderId, partyRole: "RECIPIENT" });
  });

  it("повторный event ID → дубль не создаётся (§16.7)", async () => {
    const cust = uniquePhone();
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    const e = ev("message.received", { id: "AC_d1", from: cust, to: [STORE], direction: "incoming", body: "x" }, "EV_d1");
    await ingestQuoEvent(prisma, e);
    const second = await ingestQuoEvent(prisma, e);
    expect(second.outcome).toBe("duplicate");
    expect(await prisma.orderCommunication.count({ where: { providerEventId: "EV_d1" } })).toBe(1);
  });

  it("неоднозначный номер → orderId null (§16.9)", async () => {
    const cust = uniquePhone();
    const now = today();
    const before = new Date(now.getTime() - 24 * 3600 * 1000);
    const after = new Date(now.getTime() + 24 * 3600 * 1000);
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: before });
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: after });
    const e = ev("message.received", { id: "AC_amb", from: cust, to: [STORE], direction: "incoming", body: "?" }, "EV_amb");
    e.occurredAt = now.toISOString();
    const res = await ingestQuoEvent(prisma, e);
    expect(res).toMatchObject({ outcome: "created", orderId: null });
  });

  it("незнакомый номер → orderId null (нераспознанное)", async () => {
    const res = await ingestQuoEvent(prisma, ev("message.received", { id: "AC_u1", from: "+19998887777", to: [STORE], direction: "incoming", body: "?" }, "EV_u1"));
    expect(res).toMatchObject({ outcome: "created", orderId: null });
  });

  it("пропущенный звонок сохраняется как MISSED и непрочитан (§16.6)", async () => {
    const cust = uniquePhone();
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    await ingestQuoEvent(prisma, ev("call.completed", { id: "AC_miss", from: cust, to: STORE, direction: "incoming", status: "no-answer" }, "EV_miss"));
    const comm = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: "EV_miss" } } });
    expect(comm).toMatchObject({ type: "CALL", status: "MISSED", direction: "INBOUND", readAt: null });
  });

  it("recording/transcript/summary ПОСЛЕ call.completed → обновляют запись звонка (§16.8)", async () => {
    const cust = uniquePhone();
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    await ingestQuoEvent(prisma, ev("call.completed", { id: "AC_call", from: cust, to: STORE, direction: "incoming", status: "completed", duration: 30 }, "EV_call"));
    await ingestQuoEvent(prisma, ev("call.recording.completed", { callId: "AC_call", url: "https://rec/x.mp3", type: "audio/mpeg", duration: 30 }, "EV_rec"));
    await ingestQuoEvent(prisma, ev("call.transcript.completed", { callId: "AC_call", dialogue: [{ content: "Hello" }] }, "EV_tr"));
    await ingestQuoEvent(prisma, ev("call.summary.completed", { callId: "AC_call", summary: ["Asked about delivery"] }, "EV_sum"));
    const comm = await prisma.orderCommunication.findFirst({ where: { provider: "QUO", providerResourceId: "AC_call" } });
    expect(comm).toMatchObject({ recordingUrl: "https://rec/x.mp3", transcript: "Hello", summary: "Asked about delivery" });
    // Обогащение НЕ создаёт лишних строк: одна запись на звонок.
    expect(await prisma.orderCommunication.count({ where: { providerResourceId: "AC_call" } })).toBe(1);
  });

  it("обогащение раньше call.completed → QuoIngestRetryableError, потом повтор успешен (§16.10 транзиентная ошибка)", async () => {
    const transcript = ev("call.transcript.completed", { callId: "AC_race", dialogue: [{ content: "Later" }] }, "EV_race_tr");
    await expect(ingestQuoEvent(prisma, transcript)).rejects.toBeInstanceOf(QuoIngestRetryableError);
    // Появляется call.completed → повторная обработка pending-события успешна.
    const cust = uniquePhone();
    await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    await ingestQuoEvent(prisma, ev("call.completed", { id: "AC_race", from: cust, to: STORE, direction: "incoming", status: "completed" }, "EV_race_call"));
    const retry = await ingestQuoEvent(prisma, transcript);
    expect(retry.outcome).toBe("enriched");
    const comm = await prisma.orderCommunication.findFirst({ where: { provider: "QUO", providerResourceId: "AC_race" } });
    expect(comm?.transcript).toBe("Later");
  });

  // ── Регрессия на реальных объектах QUO (live TheFlow): self-call, пропущенный без номера, отвеченный по participants ──
  it("self-call артефакт (outgoing на собственный номер магазина) → skipped, запись НЕ создаётся", async () => {
    const rid = `AC_self_${suffix}`;
    const res = await ingestQuoEvent(prisma, ev("call.completed", {
      id: rid, direction: "outgoing", status: "completed", to: STORE, participants: [STORE], duration: 6, answeredAt: null, phoneNumberId: PN_ID,
    }, `EV_self_${suffix}`));
    expect(res).toEqual({ outcome: "skipped", reason: "self_call" });
    expect(await prisma.orderCommunication.count({ where: { providerResourceId: rid } })).toBe(0);
  });

  it("реальный пропущенный входящий (status=completed, answeredAt=null, participants=[]) → непривязанный MISSED в «Нераспознанных»", async () => {
    const eid = `EV_realmiss_${suffix}`;
    const res = await ingestQuoEvent(prisma, ev("call.completed", {
      id: `AC_realmiss_${suffix}`, direction: "incoming", status: "completed", participants: [], duration: 0, answeredAt: null, phoneNumberId: PN_ID,
    }, eid));
    expect(res).toMatchObject({ outcome: "created", orderId: null });
    const comm = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: eid } } });
    expect(comm).toMatchObject({ type: "CALL", status: "MISSED", direction: "INBOUND", orderId: null, externalPhone: "", readAt: null });
  });

  it("реальный отвеченный входящий (from/to отсутствуют, есть participants) → привязка к заказу", async () => {
    const cust = uniquePhone();
    const eid = `EV_ans_${suffix}`;
    const orderId = await makeOrder({ senderPhone: cust, recipientPhone: uniquePhone(), deliveryDate: today() });
    const res = await ingestQuoEvent(prisma, ev("call.completed", {
      id: `AC_ans_${suffix}`, direction: "incoming", status: "completed", participants: [cust, STORE], duration: 18, answeredAt: "2026-07-20T16:19:44Z", phoneNumberId: PN_ID,
    }, eid));
    expect(res).toMatchObject({ outcome: "created", orderId });
    const comm = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: eid } } });
    expect(comm).toMatchObject({ orderId, type: "CALL", direction: "INBOUND", status: "COMPLETED", partyRole: "CUSTOMER", durationSeconds: 18 });
  });
});
