import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  assignInitial,
  declineOrder,
  reassignManual,
  setManualFloristPrice,
  handoffOrder,
} from "./service";

/**
 * Интеграционные тесты ядра назначения/цен. Работают на реальной БД
 * (DATABASE_URL из .env), создают собственные изолированные фикстуры
 * с уникальным суффиксом и полностью удаляют их после себя —
 * демо-данные (сид) не затрагиваются.
 *
 * Модель АВТО-ПРИНЯТИЯ: назначение флориста сразу активно (нет отдельного «Принять»).
 * Новое назначение всегда: OrderAssignment.state=ACCEPTED (+ respondedAt=now),
 * Order.assignmentStatus=ACCEPTED, Order.orderStatus=FLORIST_ACCEPTED. Инвариант —
 * у заказа не более одного активного назначения (state ∈ {ASSIGNED, ACCEPTED}).
 */

const suffix = `test-${Date.now()}`;
let siteId: string;
let floristAId: string; // основной (position 0)
let floristBId: string; // резервный (position 1)
let userAId: string;
let userBId: string;
let productId: string;
let orderId: string;

/** Инвариант: у заказа максимум одно активное назначение. */
async function activeAssignmentCount(oid: string): Promise<number> {
  return prisma.orderAssignment.count({
    where: { orderId: oid, state: { in: ["ASSIGNED", "ACCEPTED"] } },
  });
}

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

describe("assignInitial (авто-принятие)", () => {
  it("назначает основному флористу и СРАЗУ принимает: ACCEPTED/FLORIST_ACCEPTED + respondedAt", async () => {
    const order = await makeOrder();
    orderId = order.id;

    await assignInitial(orderId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristAId);
    expect(updated.assignmentStatus).toBe("ACCEPTED");
    expect(updated.orderStatus).toBe("FLORIST_ACCEPTED");
    expect(Number(updated.floristTotal)).toBe(50); // авто-цена A

    // Назначение создано сразу активным (ACCEPTED) с проставленным временем авто-принятия.
    const assignment = await prisma.orderAssignment.findFirstOrThrow({
      where: { orderId, floristId: floristAId },
    });
    expect(assignment.state).toBe("ACCEPTED");
    expect(assignment.respondedAt).not.toBeNull();
    expect(await activeAssignmentCount(orderId)).toBe(1);
  });

  it("идемпотентно — повторный вызов не переназначает и НЕ создаёт дубль назначения", async () => {
    await assignInitial(orderId); // уже принят флористом A
    await assignInitial(orderId);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristAId);
    // Ровно одно активное назначение — повторный ingest/вебхук не дублирует.
    expect(await activeAssignmentCount(orderId)).toBe(1);
    expect(await prisma.orderAssignment.count({ where: { orderId } })).toBe(1);
  });
});

describe("declineOrder", () => {
  it("при отказе основного передаёт резервному, сразу ACCEPTED, авто-цена пересчитана", async () => {
    await declineOrder(orderId, floristAId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ACCEPTED");
    expect(updated.orderStatus).toBe("FLORIST_ACCEPTED");
    expect(Number(updated.floristTotal)).toBe(30); // свежий снимок B, а не расходы A

    const declined = await prisma.orderAssignment.findFirst({
      where: { orderId, floristId: floristAId, state: "DECLINED" },
    });
    expect(declined).not.toBeNull();
    // Прежнее закрыто, новое активно — по-прежнему ровно одно активное.
    expect(await activeAssignmentCount(orderId)).toBe(1);
  });

  it("при отказе всех флористов заказ становится UNASSIGNED без зацикливания", async () => {
    await declineOrder(orderId, floristBId);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(updated.currentFloristId).toBeNull();
    expect(updated.assignmentStatus).toBe("UNASSIGNED");
    expect(Number(updated.floristTotal)).toBe(0);
    expect(await activeAssignmentCount(orderId)).toBe(0);
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

  it("переназначение с keepManualPrice=true сохраняет ручную цену, новый сразу ACCEPTED", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA
    await setManualFloristPrice(order.id, 777);

    await reassignManual(order.id, floristBId, true);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ACCEPTED");
    expect(updated.priceMode).toBe("MANUAL");
    expect(Number(updated.floristTotal)).toBe(777);
    // Прежнее назначение закрыто как REASSIGNED, активно ровно одно.
    expect(await prisma.orderAssignment.count({ where: { orderId: order.id, floristId: floristAId, state: "REASSIGNED" } })).toBe(1);
    expect(await activeAssignmentCount(order.id)).toBe(1);
  });

  it("переназначение с keepManualPrice=false берёт свежую авто-цену нового флориста", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA, авто 50
    await setManualFloristPrice(order.id, 777);

    await reassignManual(order.id, floristBId, false);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ACCEPTED");
    expect(updated.priceMode).toBe("AUTO");
    expect(Number(updated.floristTotal)).toBe(30);
    expect(await activeAssignmentCount(order.id)).toBe(1);
  });
});

describe("handoffOrder (флорист передаёт выбранному, авто-принятие)", () => {
  it("передаёт заказ выбранному: цель сразу ACCEPTED (свежая авто-цена), исходный DECLINED", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA (авто-принят)
    const r = await handoffOrder(order.id, floristAId, floristBId);
    expect(r).toEqual({ ok: true });
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.currentFloristId).toBe(floristBId);
    expect(updated.assignmentStatus).toBe("ACCEPTED");
    expect(updated.orderStatus).toBe("FLORIST_ACCEPTED");
    expect(Number(updated.floristTotal)).toBe(30); // авто-цена B, расходы A не копируются
    expect(await prisma.orderAssignment.count({ where: { orderId: order.id, floristId: floristAId, state: "DECLINED" } })).toBe(1);
    expect(await prisma.orderAssignment.count({ where: { orderId: order.id, floristId: floristBId, state: "ACCEPTED" } })).toBe(1);
    // Никаких двух активных назначений.
    expect(await activeAssignmentCount(order.id)).toBe(1);
  });

  it("можно передать ПОСЛЕ авто-принятия (из состояния ACCEPTED)", async () => {
    const order = await makeOrder();
    await assignInitial(order.id); // -> floristA сразу ACCEPTED
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).assignmentStatus).toBe("ACCEPTED");
    const r = await handoffOrder(order.id, floristAId, floristBId);
    expect(r).toEqual({ ok: true });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).currentFloristId).toBe(floristBId);
    expect(await activeAssignmentCount(order.id)).toBe(1);
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
    // Заказ не тронут, лишних назначений нет.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).currentFloristId).toBe(floristAId);
    expect(await activeAssignmentCount(order.id)).toBe(1);
    await prisma.florist.update({ where: { id: floristBId }, data: { active: true } }); // восстановить
  });
});
