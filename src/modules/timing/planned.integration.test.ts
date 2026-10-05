/**
 * Время принятого заказа для ИИ — ровно то, что «График доставки» показывает у заказа (владелец
 * 05.10.2026, FLWBR-91183: «по графику очевидно, что около трёх», а ИИ сказал получателю «около
 * 12»). Throwaway prisma dev; день — в далёком будущем, чтобы не пересечься с чужими тестами.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { loadDaySchedule, orderPlanned } from "./load";

const suffix = `planned-${Date.now()}`;
// 15.04.2031, 10:00 в Лос-Анджелесе (PDT, UTC−7).
const NOW = new Date("2031-04-15T17:00:00Z");
const DAY = "2031-04-15";
const ids = { orders: [] as string[], sites: [] as string[], users: [] as string[], florists: [] as string[] };

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  await prisma.florist.deleteMany({ where: { id: { in: ids.florists } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.site.deleteMany({ where: { id: { in: ids.sites } } });
});

describe("время принятого заказа для ИИ = «График доставки»", () => {
  it("у каждого заказа очереди — то же плановое время, что на графике, а не «если втиснуть»", async () => {
    const site = await prisma.site.create({ data: { name: `FLWBR ${suffix}`, shortName: "FLWBR", platform: "WOOCOMMERCE", timezone: "America/Los_Angeles" } });
    ids.sites.push(site.id);
    const user = await prisma.user.create({ data: { name: `Флорист ${suffix}`, email: `${suffix}@t.local`, role: "FLORIST", passwordHash: "x" } });
    ids.users.push(user.id);
    const florist = await prisma.florist.create({ data: { userId: user.id, workStartMin: 10 * 60 } });
    ids.florists.push(florist.id);

    // Пять букетов на одно окно 11–15: очередь растёт, и у последних время по графику позже начала окна.
    for (const n of ["2001", "2002", "2003", "2004", "2005"]) {
      const o = await prisma.order.create({
        data: {
          orderNumber: `FLWBR-${n}-${suffix}`, site: { connect: { id: site.id } },
          platform: "WOOCOMMERCE", source: "Test", orderStatus: "CONFIRMED",
          externalCreatedAt: NOW, deliveryDate: new Date(`${DAY}T00:00:00Z`),
          deliveryWindow: "11:00 - 15:00", windowFrom: 11 * 60, windowTo: 15 * 60,
          senderName: "Anna", senderPhone: `+1310555${n}`, recipientName: "Ann", recipientPhone: "+13105559999",
          addressLine: "1 Main St", city: "LA", zip: "90001",
          itemsTotal: new Prisma.Decimal(165), customerTotal: new Prisma.Decimal(165),
          currentFlorist: { connect: { id: florist.id } },
          items: { create: [{ name: "Roses", quantity: 1, externalPrice: new Prisma.Decimal(165) }] },
        },
      });
      ids.orders.push(o.id);
    }

    const day = await loadDaySchedule(prisma, DAY, NOW);
    const queue = day.florists.find((f) => f.id === florist.id)!.orders;
    expect(queue).toHaveLength(5);
    for (const o of queue) {
      expect(o.plannedAt).not.toBeNull();
      expect(await orderPlanned(prisma, o.id, NOW)).toBe(o.plannedAt);
    }
    const planned = queue.map((o) => o.plannedAt!);
    expect(Math.max(...planned)).toBeGreaterThan(Math.min(...planned));
    expect(Math.max(...planned)).toBeGreaterThan(11 * 60);
  });
});
