/**
 * Список заказов, которые нужно дополнить. Требует живой БД в DATABASE_URL.
 *
 * История: экран показывал «5 дн. без полных данных» и вёл в очередь по дням. День не
 * чинится — чинится заказ, и владельцу приходилось заходить в день, чтобы там узнать, какие
 * заказы виноваты. Теперь список сразу заказов.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { listIncompleteOrders } from "./incompleteOrders";

const RUN = `inco-${Date.now()}`;
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-31T00:00:00.000Z");
const DAY = new Date("2026-08-12T00:00:00.000Z");
let siteId = "";
let ownerId = "";
let secondaryId = "";

async function makeOrder(num: string, over: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      orderNumber: num,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-08-11T10:00:00Z"),
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
      orderStatus: "DELIVERED",
      paymentStatus: "PAID",
      ...over,
    },
  });
}

beforeAll(async () => {
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-08-01";
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-08-01";

  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "INC", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;

  const owner = await prisma.user.create({
    data: { name: "Владелец", email: `${RUN}-o@example.com`, role: "OWNER", passwordHash: "x" },
  });
  ownerId = owner.id;

  const user = await prisma.user.create({
    data: { name: "Ольга", email: `${RUN}-s@example.com`, role: "FLORIST", passwordHash: "x" },
  });
  const florist = await prisma.florist.create({ data: { userId: user.id, financeVisibility: "MAKER_ONLY" } });
  secondaryId = florist.id;
  await prisma.floristFinanceProfile.create({
    data: { floristId: secondaryId, model: "SECONDARY", effectiveFrom: FROM, active: true, createdBy: ownerId },
  });
});

beforeEach(async () => {
  await prisma.order.deleteMany({ where: { siteId } });
});

afterAll(async () => {
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: secondaryId } }).catch(() => {});
  await prisma.florist.delete({ where: { id: secondaryId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("что нужно дополнить", () => {
  it("заказ без заполненных расходов попадает в список с указанием, чего не хватает", async () => {
    const order = await makeOrder(`${RUN}-A`);

    const list = await listIncompleteOrders(FROM, TO);
    const row = list.find((o) => o.id === order.id)!;
    expect(row.orderNumber).toBe(`${RUN}-A`);
    expect(row.missing).toContain("DELIVERY_ACTUAL_COST");
  });

  it("заказ второстепенного без цены работы попадает с отдельной причиной", async () => {
    // Ноль здесь означает «цена не задана», а не «делаем бесплатно».
    const order = await makeOrder(`${RUN}-B`, { currentFloristId: secondaryId, floristTotal: "0.00" });

    const row = (await listIncompleteOrders(FROM, TO)).find((o) => o.id === order.id)!;
    expect(row.noFloristPrice).toBe(true);
    expect(row.floristName).toBe("Ольга");
  });

  it("заполненный заказ в список не попадает", async () => {
    const order = await makeOrder(`${RUN}-C`, {
      deliveryActualCost: "12.00",
      deliveryActualCostConfirmedAt: new Date(),
      currentFloristId: secondaryId,
      floristTotal: "40.00",
    });

    // Расходы кроме доставки всё ещё не заданы настройками магазина, поэтому проверяем
    // конкретно: причина «нет цены флориста» исчезла.
    const row = (await listIncompleteOrders(FROM, TO)).find((o) => o.id === order.id);
    expect(row?.noFloristPrice ?? false).toBe(false);
  });

  it("недоставленный заказ не считается недозаполненным", async () => {
    // Он ещё не должен был попасть в расчёт: требовать по нему данные рано.
    await makeOrder(`${RUN}-D`, { orderStatus: "CONFIRMED" });
    expect((await listIncompleteOrders(FROM, TO)).some((o) => o.orderNumber === `${RUN}-D`)).toBe(false);
  });

  it("заказ вне периода не попадает", async () => {
    await makeOrder(`${RUN}-E`, { deliveryDate: new Date("2026-09-15T00:00:00.000Z") });
    expect((await listIncompleteOrders(FROM, TO)).some((o) => o.orderNumber === `${RUN}-E`)).toBe(false);
  });

  it("список идёт по дате доставки — читается, а не перебирается", async () => {
    await makeOrder(`${RUN}-late`, { deliveryDate: new Date("2026-08-20T00:00:00.000Z") });
    await makeOrder(`${RUN}-early`, { deliveryDate: new Date("2026-08-05T00:00:00.000Z") });

    const dates = (await listIncompleteOrders(FROM, TO)).map((o) => o.deliveryDate);
    expect(dates).toEqual([...dates].sort());
  });
});
