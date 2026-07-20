import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { markOrderCommunicationsRead, linkCommunicationToOrder, ignoreCommunication, listUnrecognized, suggestOrdersForCommunication } from "./communicationsService";

const suffix = `quosvc-${Date.now()}`;
let siteId: string;
const orderIds: string[] = [];
const commIds: string[] = [];
let seq = 6000;
const uniquePhone = () => `+1310556${(seq++).toString().padStart(4, "0")}`;

async function makeOrder(senderPhone: string, recipientPhone: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#SVC-${suffix}-${Math.random().toString(36).slice(2, 8)}`, site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "x",
      senderName: "B", senderPhone, recipientName: "R", recipientPhone, addressLine: "1", city: "SM", zip: "90401",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    }, select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}
async function insertComm(over: Partial<Prisma.OrderCommunicationUncheckedCreateInput> & { externalPhoneNormalized: string }): Promise<string> {
  const c = await prisma.orderCommunication.create({
    data: {
      provider: "QUO", type: "SMS", direction: "INBOUND", status: "RECEIVED",
      externalPhone: over.externalPhoneNormalized, occurredAt: new Date(), ...over,
    }, select: { id: true },
  });
  commIds.push(c.id);
  return c.id;
}

beforeAll(async () => { siteId = (await prisma.site.create({ data: { name: `Svc ${suffix}`, shortName: "SVC", platform: "WOOCOMMERCE" } })).id; });
afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { id: { in: commIds } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("communicationsService", () => {
  it("markOrderCommunicationsRead помечает входящие SMS и пропущенные звонки, не трогая прочее (§16.3)", async () => {
    const orderId = await makeOrder(uniquePhone(), uniquePhone());
    const inSms = await insertComm({ orderId, type: "SMS", direction: "INBOUND", status: "RECEIVED", externalPhoneNormalized: uniquePhone() });
    const missed = await insertComm({ orderId, type: "CALL", direction: "INBOUND", status: "MISSED", externalPhoneNormalized: uniquePhone() });
    const outSms = await insertComm({ orderId, type: "SMS", direction: "OUTBOUND", status: "DELIVERED", externalPhoneNormalized: uniquePhone() });
    const answered = await insertComm({ orderId, type: "CALL", direction: "INBOUND", status: "COMPLETED", externalPhoneNormalized: uniquePhone() });

    const count = await markOrderCommunicationsRead(prisma, orderId);
    expect(count).toBe(2);
    expect((await prisma.orderCommunication.findUnique({ where: { id: inSms } }))!.readAt).toBeTruthy();
    expect((await prisma.orderCommunication.findUnique({ where: { id: missed } }))!.readAt).toBeTruthy();
    expect((await prisma.orderCommunication.findUnique({ where: { id: outSms } }))!.readAt).toBeNull();
    expect((await prisma.orderCommunication.findUnique({ where: { id: answered } }))!.readAt).toBeNull();

    // Повторный вызов — идемпотентно ничего нового.
    expect(await markOrderCommunicationsRead(prisma, orderId)).toBe(0);
  });

  it("listUnrecognized — только orderId=null и не ignored; фильтр по типу/направлению", async () => {
    const p = uniquePhone();
    const linked = await insertComm({ orderId: await makeOrder(p, uniquePhone()), externalPhoneNormalized: p });
    const unl = await insertComm({ externalPhoneNormalized: uniquePhone(), type: "SMS", direction: "INBOUND" });
    const call = await insertComm({ externalPhoneNormalized: uniquePhone(), type: "CALL", direction: "INBOUND", status: "MISSED" });
    const ignored = await insertComm({ externalPhoneNormalized: uniquePhone(), ignoredAt: new Date() });

    const all = await listUnrecognized(prisma, { take: 500 });
    const ids = all.map((x) => x.id);
    expect(ids).toContain(unl);
    expect(ids).toContain(call);
    expect(ids).not.toContain(linked); // привязан
    expect(ids).not.toContain(ignored); // игнорирован

    const onlyCalls = await listUnrecognized(prisma, { type: "CALL", take: 500 });
    expect(onlyCalls.map((x) => x.id)).toContain(call);
    expect(onlyCalls.map((x) => x.id)).not.toContain(unl);
  });

  it("linkCommunicationToOrder переносит событие в заказ (§16.6)", async () => {
    const orderId = await makeOrder(uniquePhone(), uniquePhone());
    const commId = await insertComm({ externalPhoneNormalized: uniquePhone(), ignoredAt: new Date() });
    const r = await linkCommunicationToOrder(prisma, commId, orderId);
    expect(r.ok).toBe(true);
    const c = await prisma.orderCommunication.findUnique({ where: { id: commId } });
    expect(c).toMatchObject({ orderId });
    expect(c!.ignoredAt).toBeNull(); // привязка снимает игнор
    // Появляется в истории заказа, исчезает из нераспознанных.
    expect((await listUnrecognized(prisma, { take: 500 })).map((x) => x.id)).not.toContain(commId);
  });

  it("ignoreCommunication убирает из активного списка (§16.7)", async () => {
    const commId = await insertComm({ externalPhoneNormalized: uniquePhone() });
    expect((await listUnrecognized(prisma, { take: 500 })).map((x) => x.id)).toContain(commId);
    await ignoreCommunication(prisma, commId);
    expect((await listUnrecognized(prisma, { take: 500 })).map((x) => x.id)).not.toContain(commId);
  });

  it("suggestOrdersForCommunication предлагает заказ по номеру", async () => {
    const phone = uniquePhone();
    const orderId = await makeOrder(phone, uniquePhone());
    const commId = await insertComm({ externalPhoneNormalized: phone });
    const sugg = await suggestOrdersForCommunication(prisma, commId);
    expect(sugg.map((s) => s.orderId)).toContain(orderId);
    expect(sugg.find((s) => s.orderId === orderId)?.role).toBe("CUSTOMER");
  });
});
