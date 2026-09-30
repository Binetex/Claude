/**
 * Доплата к заказу (29.09.2026). Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, из-за чего доплата испортила бы деньги или потерялась: сумма ложится и в товары,
 * и в итог заказчика (из них считают прибыль и день), флорист узнаёт, ЧТО изменилось, но не видит
 * денег, а у ручного заказа последующая правка налога не съедает доплату.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { addOrderSurcharge, orderSurchargeTotal } from "./surcharge";
import { updateManualOrderCharges } from "./manualCharges";
import { getTelegramEvent } from "@/integrations/telegram/registry";

const RUN = `sur-${Date.now()}`;
let siteId = "";
let floristId = "";
const userIds: string[] = [];
let actor = { userId: "", role: "OWNER" as const };
const orderIds: string[] = [];

async function makeOrder(source: "MANUAL" | "Website", withFlorist = true) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${orderIds.length}`,
      siteId,
      platform: "WOOCOMMERCE",
      source,
      externalCreatedAt: new Date("2026-09-29T10:00:00Z"),
      deliveryDate: new Date("2026-09-30T00:00:00Z"),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "120.00",
      tax: "10.00",
      customerTotal: "130.00",
      customerNote: "Звонить заранее",
      ...(withFlorist ? { currentFloristId: floristId } : {}),
    },
  });
  orderIds.push(order.id);
  return order.id;
}

const notices = (orderId: string) =>
  prisma.outboxEvent.findMany({ where: { eventType: "telegram.notify", aggregateId: orderId }, select: { payload: true } });

beforeAll(async () => {
  const site = await prisma.site.create({ data: { name: `${RUN}-site`, shortName: "SUR", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } });
  siteId = site.id;
  const owner = await prisma.user.create({ data: { name: "Владелец", email: `${RUN}-o@example.com`, role: "OWNER", passwordHash: "x" } });
  const fl = await prisma.user.create({ data: { name: "Флорист", email: `${RUN}-f@example.com`, role: "FLORIST", passwordHash: "x" } });
  userIds.push(owner.id, fl.id);
  actor = { userId: owner.id, role: "OWNER" };
  floristId = (await prisma.florist.create({ data: { userId: fl.id, active: true, financeVisibility: "FULL" } })).id;
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } }).catch(() => {});
  await prisma.orderAudit.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.florist.delete({ where: { id: floristId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("доплата к заказу", () => {
  it("ложится в сумму товаров и итог заказчика, и журнал помнит, сколько из них доплата", async () => {
    const id = await makeOrder("Website");
    expect(await addOrderSurcharge(id, { amount: 60, note: "Вместо Golden Chestnut — Red Roses & Vase", notifyFlorist: true }, actor)).toEqual({ ok: true });

    const o = await prisma.order.findUniqueOrThrow({ where: { id }, select: { itemsTotal: true, customerTotal: true, customerNote: true } });
    expect(Number(o.itemsTotal)).toBe(180);
    expect(Number(o.customerTotal)).toBe(190);
    expect(await orderSurchargeTotal(id)).toBe(60);
    // Что изменилось — первой строкой заметки, прежняя заметка не пропала.
    expect(o.customerNote).toMatch(/^\d\d\.\d\d \d\d:\d\d · Изменение заказа: Вместо Golden Chestnut — Red Roses & Vase\nЗвонить заранее$/);
  });

  it("флористу — что изменилось, без денег", async () => {
    const id = await makeOrder("Website");
    await addOrderSurcharge(id, { amount: 45.5, note: "Добавить вазу", notifyFlorist: true }, actor);

    const [n] = await notices(id);
    const payload = n.payload as { type: string; floristId: string; context: Record<string, unknown> };
    expect(payload.type).toBe("order.florist_note");
    expect(payload.floristId).toBe(floristId);
    expect(payload.context).toMatchObject({ text: "Добавить вазу" });
    expect(Object.keys(payload.context).sort()).toEqual(["occurrence", "text"]); // сумма флористу не уходит
  });

  it("две доплаты с галочкой — два НОВЫХ сообщения флористу, а не правка первого", async () => {
    const id = await makeOrder("Website");
    await addOrderSurcharge(id, { amount: 10, note: "Шарик", notifyFlorist: true }, actor);
    await addOrderSurcharge(id, { amount: 12, note: "Шоколад", notifyFlorist: true }, actor);
    // Ключ сообщения считается так же, как в обработчике Telegram: совпади он — вторая доплата
    // молча переписала бы первое сообщение, и флорист её не заметил бы.
    const keys = (await notices(id)).map((n) => {
      const p = n.payload as { orderId: string; floristId: string; context: { occurrence?: string } };
      return getTelegramEvent("order.florist_note")!.dedupeKey({ orderId: p.orderId, floristId: p.floristId, occurrence: p.context.occurrence ?? null });
    });
    expect(new Set(keys).size).toBe(2);
  });

  it("без галочки или без флориста — флористу не пишем", async () => {
    const quiet = await makeOrder("Website");
    await addOrderSurcharge(quiet, { amount: 10, note: "Открытка побольше", notifyFlorist: false }, actor);
    const nobody = await makeOrder("Website", false);
    await addOrderSurcharge(nobody, { amount: 10, note: "Открытка побольше", notifyFlorist: true }, actor);
    expect(await notices(quiet)).toHaveLength(0);
    expect(await notices(nobody)).toHaveLength(0);
  });

  it("две доплаты складываются", async () => {
    const id = await makeOrder("Website");
    await addOrderSurcharge(id, { amount: 20, note: "Шарик", notifyFlorist: false }, actor);
    await addOrderSurcharge(id, { amount: 15.25, note: "Шоколад", notifyFlorist: false }, actor);
    expect(await orderSurchargeTotal(id)).toBe(35.25);
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id }, select: { customerTotal: true } })).customerTotal)).toBe(165.25);
  });

  it("ручной заказ: правка налога после доплаты доплату не съедает", async () => {
    const id = await makeOrder("MANUAL");
    await addOrderSurcharge(id, { amount: 60, note: "Другой букет", notifyFlorist: false }, actor);
    const res = await updateManualOrderCharges(id, { tax: 12, tip: 0, discount: 0, deliveryCustomerCost: 0 }, actor);
    expect(res).toEqual({ ok: true, customerTotal: 192 });
  });

  it("нулевая сумма и пустое описание — отказ без следов", async () => {
    const id = await makeOrder("Website");
    expect(await addOrderSurcharge(id, { amount: 0, note: "x", notifyFlorist: false }, actor)).toMatchObject({ ok: false });
    expect(await addOrderSurcharge(id, { amount: 10, note: "   ", notifyFlorist: false }, actor)).toMatchObject({ ok: false });
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id }, select: { customerTotal: true } })).customerTotal)).toBe(130);
    expect(await orderSurchargeTotal(id)).toBe(0);
  });
});
