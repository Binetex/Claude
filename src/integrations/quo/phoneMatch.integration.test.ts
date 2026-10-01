/**
 * Поиск заказа по номеру собеседника на реальной БД (throwaway prisma dev).
 *
 * 01.10.2026: входящие получателя THEFLOW-20888 не привязались к заказу. Номер в заказе записан без
 * «+1» («9495337048»), а запасной поиск брал 500 недавних заказов магазина без сортировки — у TheFlow
 * их за 90 дней стало 511, и сегодняшний заказ в выборку не попадал. Сообщений не было в карточке,
 * бот считал номер незнакомым и спрашивал имя на заказе.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { findCandidateOrdersByPhone } from "./ingest";
import { reprocessUnlinkedCommunications } from "./communicationsService";

const suffix = `phonematch-${Date.now()}`;
const siteIds: string[] = [];

async function site(shortName: string, pn: string | null) {
  const s = await prisma.site.create({ data: { name: `${shortName} ${suffix}`, shortName, platform: "WOOCOMMERCE", quoPhoneNumberId: pn, quoEnabled: true } });
  siteIds.push(s.id);
  return s;
}

function orderData(siteId: string, n: string, phones: { sender: string; recipient: string }): Prisma.OrderCreateManyInput {
  return {
    orderNumber: `PM-${n}-${suffix}`, siteId, platform: "WOOCOMMERCE", source: "Test", orderStatus: "CONFIRMED",
    externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "11:00 - 15:00",
    senderName: "S", senderPhone: phones.sender, recipientName: "R", recipientPhone: phones.recipient,
    addressLine: "1 Main St", city: "LA", zip: "90001", itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(100),
  };
}

afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { externalPhoneNormalized: { in: ["+19495550123", "+19495550456"] }, sendKey: null, providerEventId: { startsWith: `EV-${suffix}` } } });
  await prisma.order.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
});

describe("заказ по номеру собеседника", () => {
  it("находит сегодняшний заказ с номером без «+1», даже когда недавних заказов магазина больше 500", async () => {
    const s = await site("PMA", null);
    // Сначала 520 других недавних заказов, потом нужный — как у TheFlow 01.10.2026.
    await prisma.order.createMany({ data: Array.from({ length: 520 }, (_, i) => orderData(s.id, `d${i}`, { sender: `+1310555${String(i).padStart(4, "0")}`, recipient: "+13105559999" })) });
    await prisma.order.create({ data: orderData(s.id, "target", { sender: "+13105558888", recipient: "9495550123" }) as Prisma.OrderUncheckedCreateInput });

    const found = await findCandidateOrdersByPhone(prisma, "+19495550123", s.id);
    expect(found).toHaveLength(1);
    expect(found[0].recipientPhoneE164).toBe("+19495550123");
  });

  it("перепривязка ищет заказ только у магазина, на чей номер пришло сообщение", async () => {
    const theflow = await site("PMT", `PN-T-${suffix}`);
    const paradise = await site("PMP", `PN-P-${suffix}`);
    // Тот же человек заказывал в Paradise, а пишет на номер TheFlow — заказа TheFlow у него нет.
    await prisma.order.create({ data: orderData(paradise.id, "par", { sender: "(949) 555-0456", recipient: "+13105559999" }) as Prisma.OrderUncheckedCreateInput });
    const comm = await prisma.orderCommunication.create({
      data: {
        provider: "QUO", providerEventId: `EV-${suffix}-1`, providerPhoneNumberId: `PN-T-${suffix}`, type: "SMS", direction: "INBOUND",
        status: "RECEIVED", externalPhone: "+19495550456", externalPhoneNormalized: "+19495550456", messageText: "what is the eta", occurredAt: new Date(),
      },
    });
    await reprocessUnlinkedCommunications(prisma, { limit: 50 });
    expect((await prisma.orderCommunication.findUnique({ where: { id: comm.id } }))?.orderId).toBeNull();

    // Заказ в TheFlow появился — теперь привязывается к нему.
    const own = await prisma.order.create({ data: orderData(theflow.id, "own", { sender: "9495550456", recipient: "+13105559999" }) as Prisma.OrderUncheckedCreateInput });
    await reprocessUnlinkedCommunications(prisma, { limit: 50 });
    expect(await prisma.orderCommunication.findUnique({ where: { id: comm.id } })).toMatchObject({ orderId: own.id, partyRole: "CUSTOMER" });
  });
});
