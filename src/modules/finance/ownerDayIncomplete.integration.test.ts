/**
 * Разбор дня называет заказы, из-за которых он не считается. Требует живой БД в DATABASE_URL.
 *
 * История: экран говорил «по заказам не хватает данных» и замолкал. Система знала, в каких
 * именно заказах пробел, но отправляла владельца искать его вручную среди всех заказов дня.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { getOwnerDay } from "./ownerDashboard";

const RUN = `odi-${Date.now()}`;
const DAY = new Date("2026-08-14T00:00:00.000Z");
let siteId = "";
const orderIds: string[] = [];

async function makeDeliveredOrder(num: string, opts: { actualCost?: string | null } = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: num,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-08-13T10:00:00Z"),
      deliveryDate: DAY,
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "100.00",
      customerTotal: "120.00",
      tax: "0.00",
      tip: "0.00",
      deliveryCustomerCost: "20.00",
      orderStatus: "DELIVERED",
      paymentStatus: "PAID",
      ...(opts.actualCost !== undefined && opts.actualCost !== null
        ? { deliveryActualCost: opts.actualCost, deliveryActualCostConfirmedAt: new Date() }
        : {}),
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "ODI", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
});

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { siteId } });
  orderIds.length = 0;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("день, который не считается", () => {
  it("называет номера заказов, где не хватает данных", async () => {
    await makeDeliveredOrder(`${RUN}-A`);
    await makeDeliveredOrder(`${RUN}-B`);

    const detail = await getOwnerDay(DAY);
    const numbers = detail!.incompleteOrders.map((o) => o.orderNumber);
    expect(numbers).toContain(`${RUN}-A`);
    expect(numbers).toContain(`${RUN}-B`);
  });

  it("говорит, чего именно не хватает в каждом", async () => {
    // Без подтверждённой фактической доставки заказ считаться не может: ноль там означал бы
    // «доставка бесплатна» и завысил бы прибыль.
    await makeDeliveredOrder(`${RUN}-C`);

    const detail = await getOwnerDay(DAY);
    expect(detail!.incompleteOrders[0].missing).toContain("DELIVERY_ACTUAL_COST");
  });

  it("номера отсортированы — список читается, а не перебирается", async () => {
    await makeDeliveredOrder(`${RUN}-Z`);
    await makeDeliveredOrder(`${RUN}-A`);

    const detail = await getOwnerDay(DAY);
    const numbers = detail!.incompleteOrders.map((o) => o.orderNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a.localeCompare(b)));
  });

  it("у каждого заказа есть id — чтобы ссылка вела в его разбор", async () => {
    const order = await makeDeliveredOrder(`${RUN}-D`);
    const detail = await getOwnerDay(DAY);
    expect(detail!.incompleteOrders.map((o) => o.id)).toContain(order.id);
  });
});
