/**
 * Правка сумм ручного заказа. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, из-за чего правка молча испортила бы деньги: чужой (импортированный) заказ
 * править нельзя, итог заказчика обязан совпадать с суммой слагаемых до цента, а отказ обязан
 * не оставлять следов в заказе.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { updateManualOrderCharges } from "./manualCharges";

const RUN = `chg-${Date.now()}`;
let siteId = "";
let actor = { userId: "", role: "OWNER" as const };
const orderIds: string[] = [];

async function makeOrder(source: "MANUAL" | "Website", charges?: Partial<Record<string, string>>) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${orderIds.length}`,
      siteId,
      platform: "SHOPIFY",
      source,
      externalCreatedAt: new Date("2026-08-19T10:00:00Z"),
      deliveryDate: new Date("2026-08-20T00:00:00Z"),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "100.00",
      tax: "0.00",
      tip: "0.00",
      discount: "0.00",
      deliveryCustomerCost: "0.00",
      customerTotal: "100.00",
      ...charges,
    },
  });
  orderIds.push(order.id);
  return order.id;
}

const read = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: { tax: true, tip: true, discount: true, deliveryCustomerCost: true, customerTotal: true },
  });

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "CHG", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
  const user = await prisma.user.create({
    data: { name: "Владелец", email: `${RUN}@example.com`, role: "OWNER", passwordHash: "x" },
  });
  actor = { userId: user.id, role: "OWNER" };
});

afterAll(async () => {
  await prisma.orderAudit.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: actor.userId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("кого вообще можно править", () => {
  it("импортированный заказ править нельзя", async () => {
    // Суммы приходят с платформы: ближайшая синхронизация вернула бы старые числа, и правка
    // выглядела бы применённой ровно до следующего опроса.
    const id = await makeOrder("Website");
    const res = await updateManualOrderCharges(id, { tax: 9, tip: 0, discount: 0, deliveryCustomerCost: 0 }, actor);

    expect(res).toMatchObject({ ok: false });
    expect(Number((await read(id)).tax)).toBe(0);
  });
});

describe("арифметика итога", () => {
  it("итог = товары + налог + чаевые + доставка − скидка", async () => {
    const id = await makeOrder("MANUAL");
    const res = await updateManualOrderCharges(id, { tax: 9.25, tip: 15, discount: 10, deliveryCustomerCost: 20 }, actor);

    expect(res).toMatchObject({ ok: true, customerTotal: 134.25 });
    expect(Number((await read(id)).customerTotal)).toBe(134.25);
  });

  it("записанный итог совпадает с возвращённым, даже когда ввели больше двух знаков", async () => {
    // «10.005» округляется до цента ДО расчёта. Иначе итог в базе отличался бы от показанного.
    const id = await makeOrder("MANUAL");
    const res = await updateManualOrderCharges(id, { tax: 10.005, tip: 0, discount: 0, deliveryCustomerCost: 0 }, actor);

    expect(res).toMatchObject({ ok: true });
    const row = await read(id);
    expect(Number(row.tax)).toBe(10.01);
    expect(Number(row.customerTotal)).toBe((res as { customerTotal: number }).customerTotal);
  });

  it("скидка больше суммы заказа не сохраняется", async () => {
    const id = await makeOrder("MANUAL");
    const res = await updateManualOrderCharges(id, { tax: 0, tip: 0, discount: 500, deliveryCustomerCost: 0 }, actor);

    expect(res).toMatchObject({ ok: false });
    expect(Number((await read(id)).customerTotal)).toBe(100);
  });

  it("отрицательные и нечисловые суммы не сохраняются", async () => {
    const id = await makeOrder("MANUAL");
    for (const bad of [{ tax: -1 }, { tip: NaN }, { deliveryCustomerCost: Infinity }]) {
      const res = await updateManualOrderCharges(id, { tax: 0, tip: 0, discount: 0, deliveryCustomerCost: 0, ...bad }, actor);
      expect(res).toMatchObject({ ok: false });
    }
    expect(Number((await read(id)).customerTotal)).toBe(100);
  });
});

describe("след в аудите", () => {
  it("записываются только реально изменённые поля", async () => {
    const id = await makeOrder("MANUAL");
    await updateManualOrderCharges(id, { tax: 5, tip: 0, discount: 0, deliveryCustomerCost: 0 }, actor);

    const audit = await prisma.orderAudit.findFirstOrThrow({ where: { orderId: id }, orderBy: { createdAt: "desc" } });
    expect(audit.block).toBe("charges");
    expect(Object.keys(audit.changed as object).sort()).toEqual(["customerTotal", "tax"]);
  });

  it("сохранение без изменений не плодит записей", async () => {
    const id = await makeOrder("MANUAL");
    const same = { tax: 0, tip: 0, discount: 0, deliveryCustomerCost: 0 };
    await updateManualOrderCharges(id, same, actor);
    await updateManualOrderCharges(id, same, actor);

    expect(await prisma.orderAudit.count({ where: { orderId: id } })).toBe(0);
  });
});
