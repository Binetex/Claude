/**
 * Замки дней для сайтов на реальной БД (throwaway prisma dev): замок владельца — как есть, плюс
 * автозамок утра, посчитанный по графику в момент запроса.
 *
 * Дни — в далёком будущем: замок дня глобален (одна строка на день на все магазины), и
 * сегодняшние даты пересеклись бы с чужими тестами.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { siteDayClosures, loadDaySchedule } from "./load";

const suffix = `closures-${Date.now()}`;
// 04.03.2031, 10:00 в Лос-Анджелесе (PST, UTC−8): «сегодня» — 04.03, автозамок — 04.03–06.03.
// Перегружено СЕГОДНЯ, как 01.10.2026: на будущий день график может начать линию с 6:00
// («заранее можем и супер рано»), и восемь букетов туда помещаются.
const NOW = new Date("2031-03-04T18:00:00Z");
const BUSY = "2031-03-04";
const OWNER_LOCKED = "2031-03-05";
const EMPTY = "2031-03-06";

const ids = { orders: [] as string[], sites: [] as string[], users: [] as string[], florists: [] as string[] };

async function setup() {
  const site = await prisma.site.create({
    data: { name: `TheFlow ${suffix}`, shortName: "THEFLOW", platform: "WOOCOMMERCE", timezone: "America/Los_Angeles" },
  });
  ids.sites.push(site.id);
  const user = await prisma.user.create({ data: { name: `Настя ${suffix}`, email: `${suffix}@t.local`, role: "FLORIST", passwordHash: "x" } });
  ids.users.push(user.id);
  const florist = await prisma.florist.create({ data: { userId: user.id, workStartMin: 10 * 60 } });
  ids.florists.push(florist.id);

  // Восемь утренних букетов TheFlow на одного флориста: с 10 утра к 15:00 их не собрать.
  for (const day of [BUSY, OWNER_LOCKED]) {
    for (let i = 0; i < 8; i++) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `THEFLOW-${day}-${i}-${suffix}`,
          site: { connect: { id: site.id } },
          platform: "WOOCOMMERCE", source: "Test", orderStatus: "CONFIRMED",
          externalCreatedAt: NOW, deliveryDate: new Date(`${day}T00:00:00Z`),
          deliveryWindow: "11:00 - 15:00", windowFrom: 11 * 60, windowTo: 15 * 60,
          senderName: "Anna", senderPhone: "+13105550000", recipientName: "Ann", recipientPhone: "+13105550001",
          addressLine: "1 Main St", city: "LA", zip: "90001",
          itemsTotal: new Prisma.Decimal(165), customerTotal: new Prisma.Decimal(165),
          currentFlorist: { connect: { id: florist.id } },
          items: { create: [{ name: "Roses", quantity: 1, externalPrice: new Prisma.Decimal(165) }] },
        },
      });
      ids.orders.push(order.id);
    }
  }
}

afterAll(async () => {
  await prisma.morningClosure.deleteMany({ where: { day: { in: [BUSY, OWNER_LOCKED, EMPTY] } } });
  await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  await prisma.florist.deleteMany({ where: { id: { in: ids.florists } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.site.deleteMany({ where: { id: { in: ids.sites } } });
});

describe("замки дней для сайтов", () => {
  it("перегруженное утро закрывается само, замок владельца главнее, разгрузили — утро открыто", async () => {
    await setup();
    await prisma.morningClosure.create({ data: { day: OWNER_LOCKED, level: "DAY", createdByUserId: ids.users[0] } });

    const closed = await siteDayClosures(prisma, NOW);
    expect(closed[BUSY]).toBe(15 * 60);
    expect(closed[OWNER_LOCKED]).toBe(18 * 60); // «только вечер» владельца, а не утро автозамка
    expect(EMPTY in closed).toBe(false);

    // В графике видно, из-за какого заказа; в БД автозамок не пишется.
    const day = await loadDaySchedule(prisma, BUSY, NOW);
    expect(day.autoClose?.orderNumber).toMatch(/^THEFLOW-2031-03-04-/);
    expect(day.autoClose!.lateMin).toBeGreaterThanOrEqual(60);
    expect(await prisma.morningClosure.findUnique({ where: { day: BUSY } })).toBeNull();

    // Пять из восьми отменили — график успевает, и утро открыто без чьих-либо действий.
    await prisma.order.updateMany({ where: { id: { in: ids.orders.slice(0, 5) } }, data: { orderStatus: "CANCELLED" } });
    expect(BUSY in (await siteDayClosures(prisma, NOW))).toBe(false);
  });
});
