/**
 * Очередь флориста из базы (throwaway prisma dev): клиент, который «написывает», — вперёд среди
 * заказов с тем же сроком. День — в далёком будущем, чтобы не пересечься с чужими тестами.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { loadDaySchedule } from "./load";

const suffix = `queue-${Date.now()}`;
// 11.03.2031, 10:00 в Лос-Анджелесе (PDT, UTC−7).
const NOW = new Date("2031-03-11T17:00:00Z");
const DAY = "2031-03-11";
const ids = { orders: [] as string[], sites: [] as string[], users: [] as string[], florists: [] as string[] };

afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: ids.orders } } });
  await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  await prisma.florist.deleteMany({ where: { id: { in: ids.florists } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.site.deleteMany({ where: { id: { in: ids.sites } } });
});

describe("очередь флориста: клиент пишет — вперёд", () => {
  it("два одинаковых заказа до 15:00 — первым тот, чей клиент написал дважды за сутки", async () => {
    const site = await prisma.site.create({ data: { name: `TheFlow ${suffix}`, shortName: "THEFLOW", platform: "WOOCOMMERCE", timezone: "America/Los_Angeles" } });
    ids.sites.push(site.id);
    const user = await prisma.user.create({ data: { name: `Флорист ${suffix}`, email: `${suffix}@t.local`, role: "FLORIST", passwordHash: "x" } });
    ids.users.push(user.id);
    const florist = await prisma.florist.create({ data: { userId: user.id, workStartMin: 10 * 60 } });
    ids.florists.push(florist.id);

    const order = async (n: string) => {
      const o = await prisma.order.create({
        data: {
          orderNumber: `THEFLOW-${n}-${suffix}`, site: { connect: { id: site.id } },
          platform: "WOOCOMMERCE", source: "Test", orderStatus: "CONFIRMED",
          externalCreatedAt: NOW, deliveryDate: new Date(`${DAY}T00:00:00Z`),
          deliveryWindow: "11:00 - 15:00", windowFrom: 11 * 60, windowTo: 15 * 60,
          senderName: "Anna", senderPhone: `+1310555${n.padStart(4, "0")}`, recipientName: "Ann", recipientPhone: "+13105559999",
          addressLine: "1 Main St", city: "LA", zip: "90001",
          itemsTotal: new Prisma.Decimal(165), customerTotal: new Prisma.Decimal(165),
          currentFlorist: { connect: { id: florist.id } },
          items: { create: [{ name: "Roses", quantity: 1, externalPrice: new Prisma.Decimal(165) }] },
        },
      });
      ids.orders.push(o.id);
      return o;
    };
    // Спокойный создан первым: при равенстве всего прочего он и шёл бы первым.
    const calm = await order("1001");
    const nervous = await order("1002");
    for (const minutesAgo of [90, 30]) {
      await prisma.orderCommunication.create({
        data: {
          orderId: nervous.id, provider: "QUO", type: "SMS", direction: "INBOUND", partyRole: "CUSTOMER", status: "RECEIVED",
          externalPhone: "+13105551002", externalPhoneNormalized: "+13105551002", messageText: "when will it be delivered?",
          occurredAt: new Date(NOW.getTime() - minutesAgo * 60_000),
        },
      });
    }
    // Старое сообщение (двое суток назад) не считается: «написывает» — сейчас.
    await prisma.orderCommunication.create({
      data: {
        orderId: calm.id, provider: "QUO", type: "SMS", direction: "INBOUND", partyRole: "CUSTOMER", status: "RECEIVED",
        externalPhone: "+13105551001", externalPhoneNormalized: "+13105551001", messageText: "thanks",
        occurredAt: new Date(NOW.getTime() - 48 * 3_600_000),
      },
    });

    const day = await loadDaySchedule(prisma, DAY, NOW);
    const queue = day.florists.find((f) => f.id === florist.id)!.orders;
    expect(queue.map((o) => [o.orderNumber.split("-")[1], o.seq, o.inbound])).toEqual([
      ["1002", 1, 2],
      ["1001", 2, 0],
    ]);
  });
});
