import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { sendOrderSms } from "./send";
import { ingestQuoEvent } from "./ingest";
import { parseQuoWebhook } from "./envelope";
import { quoErrorFromStatus, quoNetworkError } from "./errors";
import type { QuoClient } from "./client";
import type { QuoSendResult } from "./types";

const suffix = `quosend-${Date.now()}`;
let siteWithNumber: string;
let siteNoNumber: string;
const orderIds: string[] = [];
const CUST = "+13105557001";
const RECIP = "+13105557002";
const STORE_NUM = "+13105550000";
const STORE_PN = "PN_store_1";

function fakeClient(send: (input: { content: string; from: string; to: string[] }) => Promise<QuoSendResult>): QuoClient {
  return {
    sendMessage: (i) => send(i),
    getMessage: async () => ({}),
    listMessages: async () => ({ data: [], nextPageToken: null }),
    getCall: async () => ({}),
    listCalls: async () => ({ data: [], nextPageToken: null }),
    getCallRecordings: async () => [],
    getCallTranscript: async () => null,
    getCallSummary: async () => null,
    listPhoneNumbers: async () => [],
  } as QuoClient;
}
const okClient = (id = "AC_sent") => fakeClient(async (i) => ({ id, status: "queued", conversationId: "CN_1", from: i.from, to: i.to }));

async function makeOrder(siteId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#QS-${suffix}-${Math.random().toString(36).slice(2, 8)}`, site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "x",
      senderName: "B", senderPhone: CUST, recipientName: "R", recipientPhone: RECIP, addressLine: "1 A", city: "SM", zip: "90401",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    }, select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}

beforeAll(async () => {
  siteWithNumber = (await prisma.site.create({ data: { name: `S1 ${suffix}`, shortName: "S1", platform: "WOOCOMMERCE", quoPhoneNumberId: STORE_PN, quoPhoneNumber: STORE_NUM, quoEnabled: true } })).id;
  siteNoNumber = (await prisma.site.create({ data: { name: `S2 ${suffix}`, shortName: "S2", platform: "WOOCOMMERCE" } })).id;
});
afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { siteId: { in: [siteWithNumber, siteNoNumber] } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteWithNumber, siteNoNumber] } } });
});

describe("sendOrderSms", () => {
  it("успешная отправка покупателю → SENT + сохранён resource/conversation/phoneNumberId", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const r = await sendOrderSms(prisma, okClient("AC_cust"), { orderId, target: "CUSTOMER", text: "Hi buyer", idempotencyKey: `k-${orderId}-1` });
    expect(r).toMatchObject({ ok: true, status: "SENT", duplicate: false });
    const c = await prisma.orderCommunication.findUnique({ where: { id: (r as { communicationId: string }).communicationId } });
    expect(c).toMatchObject({ orderId, direction: "OUTBOUND", type: "SMS", partyRole: "CUSTOMER", status: "SENT", providerResourceId: "AC_cust", providerConversationId: "CN_1", providerPhoneNumberId: STORE_PN, externalPhoneNormalized: CUST, storePhone: STORE_NUM });
  });

  it("успешная отправка получателю → partyRole RECIPIENT, номер получателя", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const r = await sendOrderSms(prisma, okClient(), { orderId, target: "RECIPIENT", text: "Hi recipient", idempotencyKey: `k-${orderId}-2` });
    const c = await prisma.orderCommunication.findUnique({ where: { id: (r as { communicationId: string }).communicationId } });
    expect(c).toMatchObject({ partyRole: "RECIPIENT", externalPhoneNormalized: RECIP, status: "SENT" });
  });

  it("магазин без QUO номера → store_no_quo_number, ничего не отправлено/не создано", async () => {
    const orderId = await makeOrder(siteNoNumber);
    const send = vi.fn();
    const r = await sendOrderSms(prisma, fakeClient(send as never), { orderId, target: "CUSTOMER", text: "x", idempotencyKey: `k-${orderId}-3` });
    expect(r).toEqual({ ok: false, code: "store_no_quo_number" });
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.orderCommunication.count({ where: { orderId } })).toBe(0);
  });

  it("пустой и слишком длинный текст → ошибки валидации, без записи", async () => {
    const orderId = await makeOrder(siteWithNumber);
    expect(await sendOrderSms(prisma, okClient(), { orderId, target: "CUSTOMER", text: "   ", idempotencyKey: `k-${orderId}-4a` })).toEqual({ ok: false, code: "empty_text" });
    expect(await sendOrderSms(prisma, okClient(), { orderId, target: "CUSTOMER", text: "a".repeat(1601), idempotencyKey: `k-${orderId}-4b` })).toEqual({ ok: false, code: "too_long" });
    expect(await prisma.orderCommunication.count({ where: { orderId } })).toBe(0);
  });

  it.each([401, 403, 429, 500])("QUO %s → запись FAILED с безопасным кодом, без авто-повтора", async (status) => {
    const orderId = await makeOrder(siteWithNumber);
    const send = vi.fn(async () => { throw quoErrorFromStatus(status); });
    const r = await sendOrderSms(prisma, fakeClient(send as never), { orderId, target: "CUSTOMER", text: "boom", idempotencyKey: `k-${orderId}-e${status}` });
    expect(r.ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1); // сервис сам НЕ повторяет
    const c = await prisma.orderCommunication.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } });
    expect(c?.status).toBe("FAILED");
    expect(JSON.stringify(c?.rawMetadata)).toContain(String(status)); // безопасный код содержит статус
  });

  it("сетевой timeout → FAILED, без авто-повтора", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const send = vi.fn(async () => { throw quoNetworkError("timeout"); });
    const r = await sendOrderSms(prisma, fakeClient(send as never), { orderId, target: "CUSTOMER", text: "hi", idempotencyKey: `k-${orderId}-net` });
    expect(r).toMatchObject({ ok: false, code: "quo_network" });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await prisma.orderCommunication.findFirst({ where: { orderId } }))?.status).toBe("FAILED");
  });

  it("повторный idempotency key (двойной клик) → второй раз duplicate, QUO вызван один раз, одна запись", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const send = vi.fn(async (i: { from: string; to: string[] }) => ({ id: "AC_once", status: "queued", conversationId: null, from: i.from, to: i.to }));
    const key = `k-${orderId}-dup`;
    const r1 = await sendOrderSms(prisma, fakeClient(send as never), { orderId, target: "CUSTOMER", text: "once", idempotencyKey: key });
    const r2 = await sendOrderSms(prisma, fakeClient(send as never), { orderId, target: "CUSTOMER", text: "once", idempotencyKey: key });
    expect(r1).toMatchObject({ ok: true, duplicate: false });
    expect(r2).toMatchObject({ ok: true, duplicate: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.orderCommunication.count({ where: { orderId, sendKey: key } })).toBe(1);
  });

  it("delivered webhook обновляет существующую запись (по message id), а не создаёт новую", async () => {
    const orderId = await makeOrder(siteWithNumber);
    await sendOrderSms(prisma, okClient("AC_deliv"), { orderId, target: "CUSTOMER", text: "track me", idempotencyKey: `k-${orderId}-d` });
    const ev = parseQuoWebhook({ id: "EV_deliv", type: "message.delivered", createdAt: new Date().toISOString(), data: { object: { id: "AC_deliv", from: STORE_NUM, to: [CUST], direction: "outgoing", status: "delivered" } } });
    await ingestQuoEvent(prisma, ev!);
    const rows = await prisma.orderCommunication.findMany({ where: { providerResourceId: "AC_deliv" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DELIVERED");
    expect(rows[0].deliveredAt).toBeTruthy();
  });

  it("delivered webhook без локальной записи → создаётся безопасная восстановленная запись", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const ev = parseQuoWebhook({ id: "EV_recover", type: "message.delivered", createdAt: new Date().toISOString(), data: { object: { id: "AC_never_sent", from: STORE_NUM, to: [CUST], direction: "outgoing", status: "delivered" } } });
    const res = await ingestQuoEvent(prisma, ev!);
    expect(res.outcome).toBe("created");
    const c = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: "EV_recover" } } });
    expect(c).toMatchObject({ orderId, direction: "OUTBOUND", status: "DELIVERED", providerResourceId: "AC_never_sent" });
  });

  it("логи не содержат полного номера и текста сообщения", async () => {
    const orderId = await makeOrder(siteWithNumber);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    await sendOrderSms(prisma, okClient(), { orderId, target: "CUSTOMER", text: "TOP SECRET BODY 42", idempotencyKey: `k-${orderId}-pii` });
    spy.mockRestore();
    const dump = logs.join("\n");
    expect(dump).not.toContain("3105557001");
    expect(dump).not.toContain("TOP SECRET BODY 42");
    expect(dump).toContain("***7001");
  });
});
