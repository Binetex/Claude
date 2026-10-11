/**
 * «Оплата не прошла» не уходит, если клиент заплатил за время задержки (владелец 11.10.2026):
 * этот же заказ или новый — на WooCommerce повторная попытка часто становится новым заказом.
 * Требует живой БД в DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { paymentRecovered } from "./handlers";

const RUN = `prec-${Date.now()}`;
let siteId = "";
let otherSiteId = "";
let seq = 0;
const T0 = new Date("2026-10-11T02:49:33Z");

async function order(opts: { site?: string; paid?: boolean; phone?: string; email?: string; at?: Date }) {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNumber: `${RUN}-${seq}`, siteId: opts.site ?? siteId, platform: "WOOCOMMERCE", source: "Website",
      externalCreatedAt: opts.at ?? T0, deliveryDate: new Date("2026-10-12T00:00:00Z"), deliveryWindow: "12:00 - 16:00",
      senderName: "Anna", senderPhone: opts.phone ?? "+13105550001", senderEmail: opts.email ?? "anna@example.com",
      recipientName: "Maria", recipientPhone: "+13105550002", addressLine: "1 Main St", city: "LA", zip: "90001",
      itemsTotal: "100.00", customerTotal: "100.00",
      paymentStatus: opts.paid ? "PAID" : "UNPAID", orderStatus: opts.paid ? "CONFIRMED" : "AWAITING_PAYMENT",
    },
    select: { id: true, siteId: true, paymentStatus: true, senderPhone: true, senderEmail: true, externalCreatedAt: true },
  });
}

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `${RUN}-a`, shortName: "PRA", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } })).id;
  otherSiteId = (await prisma.site.create({ data: { name: `${RUN}-b`, shortName: "PRB", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } })).id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { siteId: { in: [siteId, otherSiteId] } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } });
  await prisma.$disconnect();
});

describe("оплата после «не прошла»", () => {
  it("никто не платил — пишем", async () => {
    const o = await order({ phone: "+13105551001", email: "a1@example.com" });
    expect(await paymentRecovered(prisma, o)).toBeNull();
  });

  it("этот же заказ оплачен — не пишем", async () => {
    const o = await order({ paid: true });
    expect(await paymentRecovered(prisma, o)).toBe("paid_meanwhile");
  });

  it("тот же человек оплатил новый заказ — не пишем (по телефону и по почте)", async () => {
    const o = await order({ phone: "+13105551002", email: "a2@example.com" });
    await order({ paid: true, phone: "+13105551002", email: "other@example.com", at: new Date(T0.getTime() + 5 * 60000) });
    expect(await paymentRecovered(prisma, o)).toBe("paid_in_new_order");

    const o2 = await order({ phone: "+13105551003", email: "a3@example.com" });
    await order({ paid: true, phone: "+13105559999", email: "A3@example.com", at: new Date(T0.getTime() + 60000) });
    expect(await paymentRecovered(prisma, o2)).toBe("paid_in_new_order");
  });

  it("оплаченный заказ раньше этого или в другом магазине — не в счёт", async () => {
    const o = await order({ phone: "+13105551004", email: "a4@example.com" });
    await order({ paid: true, phone: "+13105551004", at: new Date(T0.getTime() - 86400000) });
    await order({ paid: true, phone: "+13105551004", site: otherSiteId, at: new Date(T0.getTime() + 60000) });
    expect(await paymentRecovered(prisma, o)).toBeNull();
  });
});
