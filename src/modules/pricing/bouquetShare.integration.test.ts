/**
 * Доля флориста от цены букета на сайте (владелец 10.10.2026: Арине — 60%). Требует живой БД в
 * DATABASE_URL.
 *
 * Проверяется то, на чём доля молча испортила бы деньги: флорист без доли (Ольга) получает ровно
 * цену каталога, как раньше; у флориста с долей букет — цена на сайте × доля, а добавка (ваза,
 * открытка) — цена каталога; индивидуальная цена флориста по-прежнему главнее; замена букета
 * считает так же, как назначение.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { applyAutoPriceSnapshot, snapshotItemFloristPrice } from "./service";

const RUN = `bsh-${Date.now()}`;
let siteId = "";
const userIds: string[] = [];
let olga = "";
let arina = "";
let bouquet = { productId: "", variantId: "" };
let vase = { productId: "", variantId: "" };
let note = { productId: "", variantId: "" };

async function makeProduct(name: string, listPrice: string, floristPrice: string, financialType: "VASE" | "CARD" | null) {
  const p = await prisma.product.create({ data: { siteId, name, externalId: `${RUN}-${name}`, financialType } });
  const v = await prisma.productVariant.create({ data: { productId: p.id, externalId: `${RUN}-${name}-v`, title: "Standard", listPrice, floristPrice } });
  return { productId: p.id, variantId: v.id };
}

async function makeFlorist(name: string, bouquetSharePercentBp: number | null) {
  const u = await prisma.user.create({ data: { name, email: `${RUN}-${name}@example.com`, role: "FLORIST", passwordHash: "x" } });
  userIds.push(u.id);
  return (await prisma.florist.create({ data: { userId: u.id, active: true, bouquetSharePercentBp } })).id;
}

/** Заказ: букет ×2 (клиент заплатил меньше цены на сайте — скидка), ваза, открытка. */
async function makeOrder() {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${Math.random().toString(36).slice(2, 7)}`,
      siteId, platform: "WOOCOMMERCE", source: "Website",
      externalCreatedAt: new Date("2026-10-09T10:00:00Z"), deliveryDate: new Date("2026-10-10T00:00:00Z"), deliveryWindow: "12:00 - 16:00",
      senderName: "Заказчик", senderPhone: "+14245550000", recipientName: "Получатель", recipientPhone: "+14245551111",
      addressLine: "1 Main St", city: "LA", zip: "90001", itemsTotal: "420.00", customerTotal: "420.00",
      items: {
        create: [
          { ...bouquet, name: "Golden Chestnut", quantity: 2, externalPrice: "180.00" },
          { ...vase, name: "Clear Glass Cylinder Vase", quantity: 1, externalPrice: "40.00" },
          { ...note, name: "Personal Note", quantity: 1, externalPrice: "1.00" },
        ],
      },
    },
    select: { id: true },
  });
  return order.id;
}

const snapshot = (orderId: string, floristId: string) => prisma.$transaction((tx) => applyAutoPriceSnapshot(tx, orderId, floristId));
const lines = async (orderId: string) =>
  Object.fromEntries(
    (await prisma.orderItem.findMany({ where: { orderId }, select: { name: true, floristItemPrice: true } })).map((i) => [i.name, i.floristItemPrice.toFixed(2)])
  );

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `${RUN}-site`, shortName: "BSH", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } })).id;
  bouquet = await makeProduct("Golden Chestnut", "199.00", "139.30", null);
  vase = await makeProduct("Clear Glass Cylinder Vase", "40.00", "15.00", "VASE");
  note = await makeProduct("Personal Note", "1.00", "0.00", "CARD");
  olga = await makeFlorist("Olga", null);
  arina = await makeFlorist("Arina", 6000);
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { siteId }, select: { id: true } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.floristProductPrice.deleteMany({ where: { floristId: { in: [olga, arina] } } }).catch(() => {});
  await prisma.product.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.florist.deleteMany({ where: { id: { in: [olga, arina] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("доля флориста от цены букета", () => {
  it("флорист без доли — цена каталога, как раньше", async () => {
    const orderId = await makeOrder();
    expect((await snapshot(orderId, olga)).toFixed(2)).toBe("293.60");
    expect(await lines(orderId)).toEqual({ "Golden Chestnut": "278.60", "Clear Glass Cylinder Vase": "15.00", "Personal Note": "0.00" });
  });

  it("с долей: букет — 60% от цены на сайте (не от оплаченной), добавки — по каталогу", async () => {
    const orderId = await makeOrder();
    // 199 × 60% = 119.40 за штуку, две штуки; ваза $15 и открытка $0 — как у Ольги.
    expect((await snapshot(orderId, arina)).toFixed(2)).toBe("253.80");
    expect(await lines(orderId)).toEqual({ "Golden Chestnut": "238.80", "Clear Glass Cylinder Vase": "15.00", "Personal Note": "0.00" });
  });

  it("индивидуальная цена флориста главнее доли", async () => {
    await prisma.floristProductPrice.create({ data: { floristId: arina, productId: bouquet.productId, variantId: bouquet.variantId, makeCost: "100.00" } });
    try {
      const orderId = await makeOrder();
      await snapshot(orderId, arina);
      expect((await lines(orderId))["Golden Chestnut"]).toBe("200.00");
    } finally {
      await prisma.floristProductPrice.deleteMany({ where: { floristId: arina } });
    }
  });

  it("замена букета считает так же, как назначение", async () => {
    const orderId = await makeOrder();
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId, name: "Golden Chestnut" }, select: { id: true } });
    const line = await prisma.$transaction((tx) => snapshotItemFloristPrice(tx, item.id, arina));
    expect(line.toFixed(2)).toBe("238.80");
  });
});
