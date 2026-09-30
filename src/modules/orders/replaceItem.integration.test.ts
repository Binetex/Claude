/**
 * Замена букета в заказе (30.09.2026). Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, из-за чего замена испортила бы деньги или флорист собрал бы не тот букет:
 * позиция получает снимок нового товара, разница цены — в суммы заказа, цена флористу
 * пересчитывается только у этой позиции и только при авто-цене, флорист получает новую
 * карточку, а товар чужого магазина и минус в итоге отвергаются без следов.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { replaceOrderItem } from "./replaceItem";
import { getTelegramEvent } from "@/integrations/telegram/registry";

const RUN = `rep-${Date.now()}`;
let siteId = "";
let otherSiteId = "";
let floristId = "";
const userIds: string[] = [];
let actor = { userId: "", role: "OWNER" as const };
let small = { productId: "", variantId: "" };
let big = { productId: "", variantId: "" };
let foreign = { productId: "", variantId: "" };

async function makeProduct(site: string, name: string, variant: string, listPrice: number, floristPrice: number, composition: string | null) {
  const p = await prisma.product.create({ data: { siteId: site, name, externalId: `${RUN}-${name}`, image: `https://img.example/${name}.jpg` } });
  const v = await prisma.productVariant.create({
    data: { productId: p.id, externalId: `${RUN}-${name}-v`, title: variant, listPrice, floristPrice, floristComposition: composition, image: `https://img.example/${name}-${variant}.jpg` },
  });
  return { productId: p.id, variantId: v.id };
}

async function makeOrder(opts: { priceMode?: "AUTO" | "MANUAL"; withFlorist?: boolean } = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${Math.random().toString(36).slice(2, 7)}`,
      siteId,
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date("2026-09-30T10:00:00Z"),
      deliveryDate: new Date("2026-10-01T00:00:00Z"),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "120.00",
      customerTotal: "130.00",
      floristTotal: opts.priceMode === "MANUAL" ? "70.00" : "50.00",
      priceMode: opts.priceMode ?? "AUTO",
      ...(opts.withFlorist === false ? {} : { currentFloristId: floristId }),
      items: {
        create: {
          productId: small.productId, variantId: small.variantId, name: "Golden Chestnut", variantName: "Small",
          quantity: 1, externalPrice: "120.00", floristItemPrice: opts.withFlorist === false ? "0.00" : "50.00",
        },
      },
    },
    select: { id: true, items: { select: { id: true } } },
  });
  return { orderId: order.id, itemId: order.items[0].id };
}

const replaced = (orderId: string) =>
  prisma.outboxEvent.findMany({ where: { eventType: "telegram.notify", aggregateId: orderId }, select: { payload: true } });

beforeAll(async () => {
  const site = await prisma.site.create({ data: { name: `${RUN}-site`, shortName: "REP", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } });
  const other = await prisma.site.create({ data: { name: `${RUN}-other`, shortName: "REPO", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } });
  siteId = site.id;
  otherSiteId = other.id;
  const owner = await prisma.user.create({ data: { name: "Владелец", email: `${RUN}-o@example.com`, role: "OWNER", passwordHash: "x" } });
  const fl = await prisma.user.create({ data: { name: "Флорист", email: `${RUN}-f@example.com`, role: "FLORIST", passwordHash: "x" } });
  userIds.push(owner.id, fl.id);
  actor = { userId: owner.id, role: "OWNER" };
  floristId = (await prisma.florist.create({ data: { userId: fl.id, active: true, financeVisibility: "FULL" } })).id;
  small = await makeProduct(siteId, "Golden Chestnut", "Small", 120, 50, "Каштаны и розы");
  big = await makeProduct(siteId, "Red Roses & Vase", "Large", 180, 80, "25 красных роз, ваза");
  foreign = await makeProduct(otherSiteId, "Чужой букет", "One", 90, 40, null);
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { siteId }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await prisma.orderAudit.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.product.deleteMany({ where: { siteId: { in: [siteId, otherSiteId] } } }).catch(() => {});
  await prisma.florist.delete({ where: { id: floristId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("замена букета в заказе", () => {
  it("позиция — снимок нового товара, разница цены — в суммы заказа, цена флористу — по каталогу", async () => {
    const { orderId, itemId } = await makeOrder();
    expect(await replaceOrderItem(orderId, itemId, { ...big, customerPrice: 180, composition: null, notifyFlorist: true }, actor)).toEqual({ ok: true });

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ productId: big.productId, variantId: big.variantId, name: "Red Roses & Vase", variantName: "Large", floristCompositionSnapshot: "25 красных роз, ваза" });
    expect(item.image).toBe("https://img.example/Red Roses & Vase-Large.jpg");
    expect(Number(item.externalPrice)).toBe(180);
    expect(Number(item.floristItemPrice)).toBe(80);

    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { itemsTotal: true, customerTotal: true, floristTotal: true, customerNote: true } });
    expect([Number(o.itemsTotal), Number(o.customerTotal), Number(o.floristTotal)]).toEqual([180, 190, 80]);
    expect(o.customerNote).toMatch(/· Букет заменён: Golden Chestnut, Small → Red Roses & Vase, Large$/);
    const audit = await prisma.orderAudit.findFirstOrThrow({ where: { orderId, block: "item_replace" } });
    expect((audit.changed as { item: unknown }).item).toEqual({ from: "Golden Chestnut, Small", to: "Red Roses & Vase, Large" });
  });

  it("флористу — новая карточка «Букет заменён» с тем, что было", async () => {
    const { orderId, itemId } = await makeOrder();
    await replaceOrderItem(orderId, itemId, { ...big, customerPrice: 180, composition: null, notifyFlorist: true }, actor);
    const [n] = await replaced(orderId);
    expect(n.payload).toMatchObject({ type: "order.item_replaced", floristId, context: { replacedFrom: "Golden Chestnut, Small" } });
  });

  it("вторая замена — ещё одна НОВАЯ карточка, а не правка первой (под фото прежнего букета)", async () => {
    const { orderId, itemId } = await makeOrder();
    await replaceOrderItem(orderId, itemId, { ...big, customerPrice: 180, composition: null, notifyFlorist: true }, actor);
    await replaceOrderItem(orderId, itemId, { ...small, customerPrice: 120, composition: null, notifyFlorist: true }, actor);
    // Ключ сообщения считается так же, как в обработчике Telegram: совпади он — вторая замена
    // молча переписала бы подпись первой карточки, и флорист о ней не узнал бы.
    const keys = (await replaced(orderId)).map((n) => {
      const p = n.payload as { orderId: string; floristId: string; context: { occurrence?: string } };
      return getTelegramEvent("order.item_replaced")!.dedupeKey({ orderId: p.orderId, floristId: p.floristId, occurrence: p.context.occurrence ?? null });
    });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("«Default Title» Shopify — не вариант: в позицию, заметку и карточку не попадает", async () => {
    const plain = await makeProduct(siteId, "Field of Dreams", "Default Title", 150, 60, null);
    const { orderId, itemId } = await makeOrder();
    await replaceOrderItem(orderId, itemId, { ...plain, customerPrice: 150, composition: null, notifyFlorist: true }, actor);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.variantName).toBeNull();
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerNote: true } });
    expect(o.customerNote).toMatch(/→ Field of Dreams$/);
  });

  it("ручная цена флористу не трогается, но строка позиции — уже нового букета", async () => {
    const { orderId, itemId } = await makeOrder({ priceMode: "MANUAL" });
    await replaceOrderItem(orderId, itemId, { ...big, customerPrice: 180, composition: "Свой состав", notifyFlorist: false }, actor);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { floristTotal: true } });
    expect(Number(o.floristTotal)).toBe(70);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(Number(item.floristItemPrice)).toBe(80);
    expect(item.floristCompositionSnapshot).toBe("Свой состав");
    expect(await replaced(orderId)).toHaveLength(0);
  });

  it("без флориста — цена ему зафиксируется при назначении, писать некому", async () => {
    const { orderId, itemId } = await makeOrder({ withFlorist: false });
    await replaceOrderItem(orderId, itemId, { ...big, customerPrice: 120, composition: null, notifyFlorist: true }, actor);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(Number(item.floristItemPrice)).toBe(0);
    // Та же цена клиенту — суммы заказа не меняются.
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerTotal: true } });
    expect(Number(o.customerTotal)).toBe(130);
    expect(await replaced(orderId)).toHaveLength(0);
  });

  it("товар чужого магазина и отрицательная цена — отказ без следов", async () => {
    const { orderId, itemId } = await makeOrder();
    expect(await replaceOrderItem(orderId, itemId, { ...foreign, customerPrice: 90, composition: null, notifyFlorist: true }, actor)).toMatchObject({ ok: false });
    expect(await replaceOrderItem(orderId, itemId, { ...big, customerPrice: -1, composition: null, notifyFlorist: true }, actor)).toMatchObject({ ok: false });
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.productId).toBe(small.productId);
    expect(await prisma.orderAudit.count({ where: { orderId } })).toBe(0);
  });
});
