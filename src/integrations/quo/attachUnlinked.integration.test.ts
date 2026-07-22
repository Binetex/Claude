/**
 * DB integration: подтягивание непривязанной QUO-переписки к заказу по телефону стороны.
 * Только в рамках QUO-номера магазина заказа; чужие/уже привязанные/ignored не трогаются.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { findUnlinkedCommunicationsForOrderPhone, attachUnlinkedCommunicationsToOrder } from "./communicationsService";

const suffix = `att-${Date.now()}`;
const PN_A = `PN-A-${Date.now()}`;
const PN_B = `PN-B-${Date.now()}`;
const CUST = "+13105551111";
const RCPT = "+13105552222";
let siteA = "", siteB = "", orderA = "", orderA2 = "";
const commIds: Record<string, string> = {};

const today = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

async function makeOrder(siteId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#AT-${suffix}-${Math.random().toString(36).slice(2, 7)}`,
      site: { connect: { id: siteId } }, platform: "WOOCOMMERCE", source: "Website",
      externalCreatedAt: new Date(), deliveryDate: today(), deliveryWindow: "12–16",
      senderName: "Buyer", senderPhone: CUST, recipientName: "R", recipientPhone: RCPT,
      addressLine: "1 A", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(10), customerTotal: new Prisma.Decimal(10),
      paymentStatus: "PAID", orderStatus: "CONFIRMED" as never,
    },
    select: { id: true },
  });
  return o.id;
}

async function makeComm(key: string, opts: { phone: string; pn: string | null; orderId?: string | null; ignored?: boolean }): Promise<string> {
  const c = await prisma.orderCommunication.create({
    data: {
      orderId: opts.orderId ?? null,
      provider: "QUO",
      providerEventId: `EV-${suffix}-${key}`,
      providerPhoneNumberId: opts.pn,
      type: "SMS", direction: "INBOUND", status: "RECEIVED",
      externalPhone: opts.phone, externalPhoneNormalized: opts.phone,
      messageText: `msg ${key}`, occurredAt: new Date(),
      ignoredAt: opts.ignored ? new Date() : null,
    },
    select: { id: true },
  });
  commIds[key] = c.id;
  return c.id;
}

beforeAll(async () => {
  const a = await prisma.site.create({ data: { name: `A ${suffix}`, shortName: `A${suffix}`.slice(0, 12), platform: "WOOCOMMERCE", quoPhoneNumberId: PN_A, quoPhoneNumber: "+13105550001", quoEnabled: true } });
  const b = await prisma.site.create({ data: { name: `B ${suffix}`, shortName: `B${suffix}`.slice(0, 12), platform: "WOOCOMMERCE", quoPhoneNumberId: PN_B, quoPhoneNumber: "+13105550002", quoEnabled: true } });
  siteA = a.id; siteB = b.id;
  orderA = await makeOrder(siteA);
  orderA2 = await makeOrder(siteA);
  await makeComm("c1", { phone: CUST, pn: PN_A }); // unlinked, наш номер → найдётся
  await makeComm("c2", { phone: CUST, pn: PN_B }); // другой магазин → НЕ найдётся
  await makeComm("c3", { phone: CUST, pn: PN_A, orderId: orderA2 }); // уже привязан к другому заказу
  await makeComm("c4", { phone: RCPT, pn: PN_A }); // получатель, наш номер
  await makeComm("c5", { phone: CUST, pn: PN_A, ignored: true }); // ignored → НЕ найдётся
});

afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { providerEventId: { startsWith: `EV-${suffix}-` } } });
  await prisma.order.deleteMany({ where: { siteId: { in: [siteA, siteB] } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
});

describe("findUnlinkedCommunicationsForOrderPhone", () => {
  it("CUSTOMER: только unlinked того же магазина; чужой номер / привязанный / ignored исключены", async () => {
    const r = await findUnlinkedCommunicationsForOrderPhone(prisma, orderA, "CUSTOMER");
    expect(r.ids).toEqual([commIds.c1]);
  });

  it("RECIPIENT: находит сообщение по телефону получателя", async () => {
    const r = await findUnlinkedCommunicationsForOrderPhone(prisma, orderA, "RECIPIENT");
    expect(r.ids).toEqual([commIds.c4]);
  });
});

describe("attachUnlinkedCommunicationsToOrder", () => {
  it("привязывает к заказу с ролью CUSTOMER; идемпотентно; чужие не трогает", async () => {
    const r1 = await attachUnlinkedCommunicationsToOrder(prisma, orderA, "CUSTOMER");
    expect(r1.attached).toBe(1);
    const c1 = await prisma.orderCommunication.findUnique({ where: { id: commIds.c1 }, select: { orderId: true, partyRole: true } });
    expect(c1).toMatchObject({ orderId: orderA, partyRole: "CUSTOMER" });

    // Повторно — ничего не привязывает (idempotent).
    const r2 = await attachUnlinkedCommunicationsToOrder(prisma, orderA, "CUSTOMER");
    expect(r2.attached).toBe(0);

    // Сообщение другого магазина и привязанное к другому заказу — не изменились.
    const c2 = await prisma.orderCommunication.findUnique({ where: { id: commIds.c2 }, select: { orderId: true } });
    const c3 = await prisma.orderCommunication.findUnique({ where: { id: commIds.c3 }, select: { orderId: true } });
    expect(c2?.orderId).toBeNull();
    expect(c3?.orderId).toBe(orderA2);
  });

  it("RECIPIENT: привязывает с ролью RECIPIENT", async () => {
    const r = await attachUnlinkedCommunicationsToOrder(prisma, orderA, "RECIPIENT");
    expect(r.attached).toBe(1);
    const c4 = await prisma.orderCommunication.findUnique({ where: { id: commIds.c4 }, select: { orderId: true, partyRole: true } });
    expect(c4).toMatchObject({ orderId: orderA, partyRole: "RECIPIENT" });
  });
});
