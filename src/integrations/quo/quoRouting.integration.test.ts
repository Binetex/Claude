/**
 * DB integration: маршрутизация входящих QUO-событий строго по phoneNumberId → Site и гейт
 * исходящих по quoEnabled. Реальная БД (локальный DATABASE_URL). Серийно.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { ingestQuoEvent } from "./ingest";
import { parseQuoWebhook } from "./envelope";
import { sendOrderSms } from "./send";
import type { NormalizedQuoEvent } from "./types";
import type { QuoClient } from "./client";

const suffix = `quort-${Date.now()}`;
const PN_A = `PN-A-${Date.now()}`;
const PN_B = `PN-B-${Date.now()}`;
const NUM_A = "+13105550001";
const NUM_B = "+13105550002";
const CUST = "+13105559999"; // ОДИН И ТОТ ЖЕ клиент присутствует в заказах обоих магазинов
let siteA = "", siteB = "", orderA = "", orderB = "";

const today = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

function ev(object: Record<string, unknown>, id: string): NormalizedQuoEvent {
  const parsed = parseQuoWebhook({ id, object: "event", apiVersion: "v3", createdAt: new Date().toISOString(), type: "message.received", data: { object } });
  if (!parsed) throw new Error("unparseable");
  return parsed;
}

async function makeOrder(siteId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#RT-${suffix}-${Math.random().toString(36).slice(2, 7)}`,
      site: { connect: { id: siteId } }, platform: "WOOCOMMERCE", source: "Website",
      externalCreatedAt: new Date(), deliveryDate: today(), deliveryWindow: "12–16",
      senderName: "Buyer", senderPhone: CUST, recipientName: "R", recipientPhone: "+13105558888",
      addressLine: "1 A", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(10), customerTotal: new Prisma.Decimal(10),
      paymentStatus: "PAID", orderStatus: "CONFIRMED" as never,
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  const a = await prisma.site.create({ data: { name: `A ${suffix}`, shortName: `A${suffix}`.slice(0, 12), platform: "WOOCOMMERCE", quoPhoneNumberId: PN_A, quoPhoneNumber: NUM_A, quoEnabled: true } });
  const b = await prisma.site.create({ data: { name: `B ${suffix}`, shortName: `B${suffix}`.slice(0, 12), platform: "WOOCOMMERCE", quoPhoneNumberId: PN_B, quoPhoneNumber: NUM_B, quoEnabled: true } });
  siteA = a.id; siteB = b.id;
  orderA = await makeOrder(siteA);
  orderB = await makeOrder(siteB);
});

afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { OR: [{ orderId: { in: [orderA, orderB] } }, { providerPhoneNumberId: { in: [PN_A, PN_B, "PN-UNKNOWN"] } }] } });
  await prisma.order.deleteMany({ where: { siteId: { in: [siteA, siteB] } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
});

describe("Входящее QUO — только в Site владельца номера", () => {
  it("phoneNumberId PN_A → заказ магазина A (не B), хотя телефон клиента одинаков в обоих", async () => {
    const res = await ingestQuoEvent(prisma, ev({ id: "AC_a1", from: CUST, to: [NUM_A], direction: "incoming", body: "hi A", phoneNumberId: PN_A }, "EV_a1"));
    expect(res).toMatchObject({ outcome: "created", orderId: orderA });
  });

  it("phoneNumberId PN_B → заказ магазина B", async () => {
    const res = await ingestQuoEvent(prisma, ev({ id: "AC_b1", from: CUST, to: [NUM_B], direction: "incoming", body: "hi B", phoneNumberId: PN_B }, "EV_b1"));
    expect(res).toMatchObject({ outcome: "created", orderId: orderB });
  });

  it("неизвестный номер → не привязывается ни к одному заказу (unlinked)", async () => {
    const res = await ingestQuoEvent(prisma, ev({ id: "AC_x1", from: CUST, to: ["+19998887777"], direction: "incoming", body: "?", phoneNumberId: "PN-UNKNOWN" }, "EV_x1"));
    if (res.outcome !== "created") throw new Error("expected created");
    expect(res.orderId).toBeNull();
  });

  it("выключенный Site (quoEnabled=false) → входящее не привязывается к его заказам", async () => {
    await prisma.site.update({ where: { id: siteB }, data: { quoEnabled: false } });
    const res = await ingestQuoEvent(prisma, ev({ id: "AC_b2", from: CUST, to: [NUM_B], direction: "incoming", body: "off", phoneNumberId: PN_B }, "EV_b2"));
    if (res.outcome !== "created") throw new Error("expected created");
    expect(res.orderId).toBeNull();
    await prisma.site.update({ where: { id: siteB }, data: { quoEnabled: true } });
  });
});

describe("Исходящее QUO — номер Site и гейт quoEnabled", () => {
  const okClient = { sendMessage: async () => ({ id: "AC_sent", conversationId: "CN1", status: "queued" }) } as unknown as QuoClient;

  it("исходящее SMS использует номер магазина (providerPhoneNumberId = PN_A)", async () => {
    const r = await sendOrderSms(prisma, okClient, { orderId: orderA, target: "CUSTOMER", text: "hello", idempotencyKey: `k-${suffix}-1` });
    expect(r.ok).toBe(true);
    const comm = await prisma.orderCommunication.findUnique({ where: { sendKey: `k-${suffix}-1` }, select: { providerPhoneNumberId: true } });
    expect(comm?.providerPhoneNumberId).toBe(PN_A);
  });

  it("выключенный Site не может отправить SMS (store_quo_disabled)", async () => {
    await prisma.site.update({ where: { id: siteB }, data: { quoEnabled: false } });
    const r = await sendOrderSms(prisma, okClient, { orderId: orderB, target: "CUSTOMER", text: "x", idempotencyKey: `k-${suffix}-2` });
    expect(r).toMatchObject({ ok: false, code: "store_quo_disabled" });
    await prisma.site.update({ where: { id: siteB }, data: { quoEnabled: true } });
  });
});
