import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  assignInitial,
  declineOrder,
  reassignManual,
  setManualFloristPrice,
  handoffOrder,
  acceptOrder,
} from "./service";

/**
 * Интеграционные тесты ядра назначения/цен. Работают на реальной БД
 * (DATABASE_URL из .env), создают собственные изолированные фикстуры
 * с уникальным суффиксом и полностью удаляют их после себя —
 * демо-данные (сид) не затрагиваются.
 */

const suffix = `test-${Date.now()}`;
let siteId: string;
let floristAId: string; // основной (position 0)
let floristBId: string; // резервный (position 1)
let userAId: string;
let userBId: string;
let productId: string;
let orderId: string;

async function makeOrder(overrides: Partial<Prisma.OrderCreateInput> = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#TEST-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Test Sender",
      senderPhone: "+10000000000",
      recipientName: "Test Recipient",
      recipientPhone: "+10000000001",
      addressLine: "1 Test St",
      city: "Testville",
      zip: "00000",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      items: {
        create: [
          {
            productId,
            name: "Test Bouquet",
            quantity: 1,
            externalPrice: new Prisma.Decimal(100),
          },
        ],
      },
      ...overrides,
    },
  });
  return order;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `Test Site ${suffix}`, shortName: "TST", platform: "WOOCOMMERCE" },
  });
  siteId = site.id;

  const userA = await prisma.user.create({
    data: { name: "Test Florist A", email: `florist-a-${suffix}@test.local`, role: "FLORIST", passwordHash: "x" },
  });
  const userB = await prisma.user.create({
    data: { name: "Test Florist B", email: `florist-b-${suffix}@test.local`, role: "FLORIST", passwordHash: "x" },
  });
  userAId = userA.id;
  userBId = userB.id;

  const floristA = await prisma.florist.create({ data: { userId: userA.id } });
  const floristB = await prisma.florist.create({ data: { userId: userB.id } });
  floristAId = floristA.id;
  floristBId = floristB.id;

  await prisma.siteFloristPriority.createMany({
    data: [
      { siteId, floristId: floristAId, position: 0 },
      { siteId, floristId: floristBId, position: 1 },
    ],
  });

  const product = await prisma.product.create({
    data: { name: "Test Bouquet", siteId, externalId: `EXT-${suffix}`, floristPrice: new Prisma.Decimal(0) },
  });
  productId = product.id;

  await prisma.floristProductPrice.createMany({
    data: [
      { productId, floristId: floristAId, makeCost: new Prisma.Decimal(50) },
      { productId, floristId: floristBId, makeCost: new Prisma.Decimal(30) },
    ],
  });
});

afterAll(async () => {
  // Порядок важен из-за внешних ключей.
  await prisma.message.deleteMany({ where: { order: { siteId } } });
  await prisma.orderAssignment.deleteMany({ where: { order: { siteId } } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.floristProductPrice.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.siteFloristPriority.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [floristAId, floristBId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  await prisma.site.delete({ where: { id: siteId } });
  await prisma.$disconnect();
});

describe("assignInitial", () => {
  it("назначает основному флористу сайта со снимком авто-цены", async () => {
    const order = await makeOrder();
    orderId = order.id;

    await assignInitial(orderId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristAId);
    expect(updated.assignmentStatus).toBe("ASSIGNED");
    expect(updated.orderStatus).toBe("ASSIGNED");
    expect(Number(updated.floristTotal)).toBe(50);
  });

  it("идемпотентно — повторный вызов не переназначает уже назначенный заказ", async () => {
    await assignInitial(orderId); // уже назначен флористу A
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristAId);
  });
});

describe("declineOrder", () => {
  it("при отказе основного передаёт резервному с пересчётом цены", async () => {
    await declineOrder(orderId, floristAId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ASSIGNED");
    expect(Number(updated.floristTotal)).toBe(30);

    const declined = await prisma.orderAssignment.findFirst({
      where: { orderId, floristId: floristAId, state: "DECLINED" },
    });
    expect(declined).not.toBeNull();
  });

  it("при отказе всех флористов заказ становится UNASSIGNED без зацикливания", async () => {
    await declineOrder(orderId, floristBId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBeNull();
    expect(updated.assignmentStatus).toBe("UNASSIGNED");
    expect(Number(updated.floristTotal)).toBe(0);
  });

  it("повторный отказ идемпотентен — не ломается и не меняет состояние", async () => {
    await declineOrder(orderId, floristAId);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.assignmentStatus).toBe("UNASSIGNED");
  });
});

describe("ручная цена и переназначение", () => {
  it("ручная цена приоритетнее авто и фиксируется в заказе", async () => {
    const order = await makeOrder();
    await assignInitial(order.id);
    await setManualFloristPrice(order.id, 999);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.priceMode).toBe("MANUAL");
    expect(Number(updated.floristTotal)).toBe(999);
  });

  it("переназначение с keepManualPrice=true сохраняет ручную цену", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA
    await setManualFloristPrice(order.id, 777);

    await reassignManual(order.id, floristBId, true);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.priceMode).toBe("MANUAL");
    expect(Number(updated.floristTotal)).toBe(777);
  });

  it("переназначение с keepManualPrice=false берёт авто-цену нового флориста", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA, авто 50
    await setManualFloristPrice(order.id, 777);

    await reassignManual(order.id, floristBId, false);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.priceMode).toBe("AUTO");
    expect(Number(updated.floristTotal)).toBe(30);
  });
});

describe("handoffOrder (флорист передаёт выбранному)", () => {
  it("передаёт заказ выбранному активному флористу: цель ASSIGNED (авто-цена), исходный DECLINED", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA (position 0)
    const r = await handoffOrder(order.id, floristAId, floristBId);
    expect(r).toEqual({ ok: true });
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ASSIGNED");
    expect(Number(updated.floristTotal)).toBe(30); // авто-цена B
    expect(await prisma.orderAssignment.count({ where: { orderId: order.id, floristId: floristAId, state: "DECLINED" } })).toBe(1);
    expect(await prisma.orderAssignment.count({ where: { orderId: order.id, floristId: floristBId, state: "ASSIGNED" } })).toBe(1);
  });

  it("нельзя передать не свой заказ", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA
    const r = await handoffOrder(order.id, floristBId, floristAId); // B пытается передать заказ A
    expect(r).toEqual({ ok: false, reason: "not_current_florist" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).currentFloristId).toBe(floristAId);
  });

  it("нельзя передать самому себе", async () => {
    const order = await makeOrder();
    await assignInitial(order.id);
    expect(await handoffOrder(order.id, floristAId, floristAId)).toEqual({ ok: false, reason: "same_florist" });
  });

  it("нельзя передать неактивному флористу", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA
    await prisma.florist.update({ where: { id: floristBId }, data: { active: false } });
    const r = await handoffOrder(order.id, floristAId, floristBId);
    expect(r).toEqual({ ok: false, reason: "target_unavailable" });
    await prisma.florist.update({ where: { id: floristBId }, data: { active: true } }); // восстановить
  });

  it("нельзя передать после принятия (только до accept)", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA (ASSIGNED)
    await acceptOrder(order.id, floristAId); // -> ACCEPTED
    expect(await handoffOrder(order.id, floristAId, floristBId)).toEqual({ ok: false, reason: "not_assignable" });
  });
});
