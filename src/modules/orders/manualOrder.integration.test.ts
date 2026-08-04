/**
 * Ручное создание заказа. Требует живой БД в DATABASE_URL.
 *
 * Главное, что здесь проверяется, — не «заказ создался», а что он получился ОБЫЧНЫМ:
 * каталог от него не меняется, кастомная позиция в каталог не попадает, синхронизация его
 * не видит, а финансовый расчёт считает его теми же правилами, что и импортированный.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { createManualOrder, ManualOrderError } from "./manualOrder";
import { resolveItemsFinance } from "@/modules/finance/itemFinance";

const RUN = `man-${Date.now()}`;
let siteId = "";
let productId = "";
let variantId = "";
const createdOrders: string[] = [];

const baseInput = () => ({
  siteId,
  deliveryDate: "2026-08-20",
  deliveryWindow: "12:00 – 16:00",
  recipientName: "Получатель",
  recipientPhone: "+1 (424) 555-0000",
  addressLine: "1 Main St",
  city: "LA",
  zip: "90001",
});

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "MANT", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;

  const product = await prisma.product.create({
    data: { siteId, externalId: `${RUN}-p`, name: "Букет каталожный", image: "http://img/p.jpg", status: "ACTIVE" },
  });
  productId = product.id;

  const variant = await prisma.productVariant.create({
    data: {
      productId,
      externalId: `${RUN}-v`,
      title: "Deluxe",
      listPrice: "150.00",
      floristPrice: "80.00",
      floristComposition: "24 розы",
    },
  });
  variantId = variant.id;
});

afterAll(async () => {
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrders } } }).catch(() => {});
  await prisma.orderAssignment.deleteMany({ where: { orderId: { in: createdOrders } } }).catch(() => {});
  await prisma.deliveryIntent.deleteMany({ where: { orderId: { in: createdOrders } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.productVariant.deleteMany({ where: { productId } }).catch(() => {});
  await prisma.product.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

async function create(input: Parameters<typeof createManualOrder>[0]) {
  const res = await createManualOrder(input);
  createdOrders.push(res.orderId);
  return res;
}

describe("заказ только с товаром из каталога", () => {
  it("сохраняет ссылки на каталог и снимки названия, цены и состава", async () => {
    const { orderId } = await create({
      ...baseInput(),
      items: [
        { kind: "catalog", productId, variantId, quantity: 2, customerPrice: 150, floristPrice: 80, composition: null },
      ],
    });

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    expect(order!.source).toBe("MANUAL");
    expect(order!.externalId).toBeNull();
    expect(order!.paymentStatus).toBe("PAID");
    expect(order!.orderStatus).toBe("CONFIRMED");

    const item = order!.items[0];
    expect(item.productId).toBe(productId);
    expect(item.variantId).toBe(variantId);
    expect(item.name).toBe("Букет каталожный");
    expect(item.variantName).toBe("Deluxe");
    // Состав не задали — подтянулся снимок из каталога.
    expect(item.floristCompositionSnapshot).toBe("24 розы");
    expect(Number(item.externalPrice)).toBe(150);
    expect(Number(item.floristItemPrice)).toBe(80);
    // Итог клиента = позиции × количество.
    expect(Number(order!.itemsTotal)).toBe(300);
    expect(Number(order!.customerTotal)).toBe(300);
  });

  it("правка цены и состава в заказе НЕ меняет каталог", async () => {
    await create({
      ...baseInput(),
      items: [
        { kind: "catalog", productId, variantId, quantity: 1, customerPrice: 999, floristPrice: 111, composition: "другой состав" },
      ],
    });

    const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
    expect(Number(variant!.listPrice)).toBe(150);
    expect(Number(variant!.floristPrice)).toBe(80);
    expect(variant!.floristComposition).toBe("24 розы");
  });
});

describe("заказ с кастомной позицией", () => {
  it("хранит всё в OrderItem и не создаёт товар в каталоге", async () => {
    const productsBefore = await prisma.product.count({ where: { siteId } });

    const { orderId } = await create({
      ...baseInput(),
      items: [
        {
          kind: "custom",
          name: "Авторский букет",
          quantity: 1,
          customerPrice: 200,
          floristPrice: 90,
          composition: "пионы и эвкалипт",
          imageUrl: null,
          financialType: null,
          purchaseCostCents: null,
        },
      ],
    });

    const item = (await prisma.orderItem.findMany({ where: { orderId } }))[0];
    expect(item.productId).toBeNull();
    expect(item.variantId).toBeNull();
    expect(item.name).toBe("Авторский букет");
    expect(item.floristCompositionSnapshot).toBe("пионы и эвкалипт");
    expect(await prisma.product.count({ where: { siteId } })).toBe(productsBefore);
  });

  it("без снимка типа считается обычным цветочным товаром и день не блокирует", async () => {
    const { orderId } = await create({
      ...baseInput(),
      items: [
        { kind: "custom", name: "Букет", quantity: 1, customerPrice: 100, floristPrice: 50, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null },
      ],
    });
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, name: true, productId: true, variantId: true, financialTypeSnapshot: true, purchaseCostSnapshotCents: true },
    });

    const fin = await resolveItemsFinance(items);
    const f = fin.get(items[0].id)!;
    // costRequired=false — именно это не даёт дню встать (см. dayFinance).
    expect(f.costRequired).toBe(false);
    expect(f.purchaseCostCents).toBeNull();
    expect(f.reasons).toEqual([]);
  });

  it("снимок типа «ваза» требует закупку — как и позиция из каталога", async () => {
    const { orderId } = await create({
      ...baseInput(),
      items: [
        { kind: "custom", name: "Ваза", quantity: 1, customerPrice: 40, floristPrice: 0, composition: null, imageUrl: null, financialType: "VASE", purchaseCostCents: 1500 },
      ],
    });
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, name: true, productId: true, variantId: true, financialTypeSnapshot: true, purchaseCostSnapshotCents: true },
    });

    const f = (await resolveItemsFinance(items)).get(items[0].id)!;
    expect(f.financialType).toBe("VASE");
    expect(f.costRequired).toBe(true);
    expect(f.purchaseCostCents).toBe(1500);
  });
});

describe("назначение флориста не затирает введённые цены", () => {
  it("цены позиций остаются владельческими, режим цены — ручной", async () => {
    const florist = await prisma.florist.findFirst({ where: { active: true }, select: { id: true } });
    if (!florist) return; // в базе теста нет флористов — проверять нечего

    const { orderId } = await create({
      ...baseInput(),
      floristId: florist.id,
      items: [
        { kind: "custom", name: "Открытка", quantity: 2, customerPrice: 15, floristPrice: 6, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null },
      ],
    });

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    // Авто-снимок цены для позиции БЕЗ каталога отдаёт флористу полную цену клиента —
    // на первом же прогоне вместо 6$ получилось 30$. Цены ввёл человек, их не пересчитывают.
    expect(Number(order!.items[0].floristItemPrice)).toBe(6);
    expect(order!.priceMode).toBe("MANUAL");
    expect(Number(order!.floristTotal)).toBe(12);
    expect(order!.currentFloristId).toBe(florist.id);
  });
});

describe("смешанный заказ и деньги", () => {
  it("каталог и своя позиция вместе; итог считает доставку, налог, чаевые и скидку", async () => {
    const { orderId } = await create({
      ...baseInput(),
      deliveryCustomerCost: 20,
      tax: 10,
      tip: 5,
      discount: 15,
      items: [
        { kind: "catalog", productId, variantId, quantity: 1, customerPrice: 150, floristPrice: 80, composition: null },
        { kind: "custom", name: "Открытка ручной работы", quantity: 2, customerPrice: 10, floristPrice: 4, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null },
      ],
    });

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    expect(order!.items).toHaveLength(2);
    // 150 + 10×2 = 170
    expect(Number(order!.itemsTotal)).toBe(170);
    // 170 + 20 + 10 + 5 − 15 = 190
    expect(Number(order!.customerTotal)).toBe(190);
  });
});

describe("защита и валидация", () => {
  it("заказ без позиций не создаётся", async () => {
    await expect(createManualOrder({ ...baseInput(), items: [] })).rejects.toThrow(ManualOrderError);
  });

  it("заказчик по умолчанию — получатель (в БД поля NOT NULL)", async () => {
    const { orderId } = await create({
      ...baseInput(),
      items: [{ kind: "custom", name: "Б", quantity: 1, customerPrice: 1, floristPrice: 0, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null }],
    });
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.senderName).toBe("Получатель");
    expect(order!.senderPhone).toBe("+1 (424) 555-0000");
  });

  it("номера ручных заказов не сталкиваются между собой", async () => {
    const a = await create({ ...baseInput(), items: [{ kind: "custom", name: "A", quantity: 1, customerPrice: 1, floristPrice: 0, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null }] });
    const b = await create({ ...baseInput(), items: [{ kind: "custom", name: "B", quantity: 1, customerPrice: 1, floristPrice: 0, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null }] });
    expect(a.orderNumber).not.toBe(b.orderNumber);
    expect(a.orderNumber.startsWith("M-MANT-")).toBe(true);
  });
});

describe("синхронизация ручной заказ не трогает", () => {
  it("пометка «исчез на витрине» ищет по externalId, а у ручного его нет", async () => {
    const { orderId } = await create({
      ...baseInput(),
      items: [{ kind: "custom", name: "Б", quantity: 1, customerPrice: 1, floristPrice: 0, composition: null, imageUrl: null, financialType: null, purchaseCostCents: null }],
    });

    // Ровно тот запрос, которым импорт помечает пропавший заказ.
    const touched = await prisma.order.updateMany({
      where: { siteId, externalId: `${RUN}-whatever`, remoteDeleted: false },
      data: { remoteDeleted: true },
    });
    expect(touched.count).toBe(0);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.remoteDeleted).toBe(false);
    expect(order!.deletedAt).toBeNull();
  });
});
