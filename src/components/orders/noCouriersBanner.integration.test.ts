/**
 * DB-интеграция: кого показывает баннер «Burq не нашёл курьеров».
 *
 * Жалоба владельца 19.09.2026: заказ OHARA-1072 висел в баннере третьи сутки, хотя флорист
 * пересоздал черновик и курьер нашёлся. Причина — баннер верил предварительной проверке,
 * сделанной при назначении флориста, и не замечал, что с тех пор появился черновик.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { noCouriersWhere } from "./NoCouriersBanner";

const RUN = `nc${crypto.randomBytes(3).toString("hex")}`;
let siteId = "";
const orderIds: string[] = [];

async function makeOrder(suffix: string, data: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#${RUN}-${suffix}`, siteId, platform: "WOOCOMMERCE", source: "Website",
      externalCreatedAt: new Date(), deliveryDate: new Date("2026-09-20T00:00:00Z"), deliveryWindow: "11:00 - 15:00",
      senderName: "S", senderPhone: "+13105550001", recipientName: "R", recipientPhone: "+13105550002",
      addressLine: "1 Main St", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1),
      paymentStatus: "PAID", orderStatus: "FLORIST_ACCEPTED",
      ...data,
    },
    select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}

async function addDelivery(orderId: string, couriersAvailable: number | null, isCurrentAttempt = true) {
  await prisma.delivery.create({
    data: { orderId, provider: "BURQ", attemptNumber: 1, isCurrentAttempt, isDraft: true, status: "DRAFT_CREATED", couriersAvailable },
  });
}

async function shown(): Promise<string[]> {
  const rows = await prisma.order.findMany({ where: { ...noCouriersWhere(), siteId }, select: { orderNumber: true } });
  return rows.map((r) => r.orderNumber).sort();
}

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "WOOCOMMERCE" } })).id;
});
afterAll(async () => {
  await prisma.delivery.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("баннер «Burq не нашёл курьеров»", () => {
  it("показывает заказ, по которому проверка нашла ноль и черновика ещё нет", async () => {
    await makeOrder("a", { couriersAvailable: 0, couriersCheckedAt: new Date() });
    expect(await shown()).toContain(`#${RUN}-a`);
  });

  it("МОЛЧИТ, когда по заказу уже создан черновик: проверка устарела (тот самый случай)", async () => {
    const id = await makeOrder("b", { couriersAvailable: 0, couriersCheckedAt: new Date("2026-09-17T21:47:00Z") });
    await addDelivery(id, null);
    expect(await shown()).not.toContain(`#${RUN}-b`);
  });

  it("но показывает, если сама попытка доставки сказала «курьеров нет»", async () => {
    const id = await makeOrder("c", { couriersAvailable: null });
    await addDelivery(id, 0);
    expect(await shown()).toContain(`#${RUN}-c`);
  });

  it("«не проверяли» тревогой не считается", async () => {
    await makeOrder("d", { couriersAvailable: null });
    expect(await shown()).not.toContain(`#${RUN}-d`);
  });

  it("курьеры нашлись — заказа в баннере нет", async () => {
    await makeOrder("e", { couriersAvailable: 3, couriersCheckedAt: new Date() });
    expect(await shown()).not.toContain(`#${RUN}-e`);
  });

  it("доставленный и отменённый не показываются, что бы ни говорила проверка", async () => {
    await makeOrder("f", { couriersAvailable: 0, orderStatus: "DELIVERED" });
    await makeOrder("g", { couriersAvailable: 0, orderStatus: "CANCELLED" });
    const list = await shown();
    expect(list).not.toContain(`#${RUN}-f`);
    expect(list).not.toContain(`#${RUN}-g`);
  });
});
