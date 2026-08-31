/**
 * Инвариант этапа: на вопрос «какие заказы не дают посчитать деньги» все три потребителя —
 * обзор флористов (listIncompleteOrders), разбор дня (getOwnerDay) и детектор очереди
 * (detectFinanceIssues) — называют ОДИН И ТОТ ЖЕ набор заказов. Требует живой БД.
 *
 * Области у них разные по построению: список и разбор дня видят заказы всех флористов,
 * детектор — только основного (доля считается по его дням) и без строк «только нет цены
 * флориста». Поэтому равенство проверяется на пересечении областей, а различия закреплены
 * явными ассертами — если детектор вдруг начнёт видеть второстепенных, тест скажет об этом
 * так же громко, как о потерянном заказе.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { listIncompleteOrders } from "./incompleteOrders";
import { getOwnerDay } from "./ownerDashboard";
import { detectFinanceIssues } from "./issues";

const RUN = `inc-${Date.now()}`;
// День недавний: окно детектора — 60 дней от «сейчас», жёсткая дата тут не выживет.
const DAY = new Date(`${new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);
const DAY_STR = DAY.toISOString().slice(0, 10);

let siteId = "";
let primaryFloristId = "";
let secondaryFloristId = "";
let primaryProfileId = "";
const orderIds: string[] = [];

async function makeDelivered(
  num: string,
  floristId: string,
  opts: { actualCost?: string; floristTotal?: string } = {}
) {
  const order = await prisma.order.create({
    data: {
      orderNumber: num,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date(DAY.getTime() - 86400_000),
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
      currentFloristId: floristId,
      ...(opts.floristTotal !== undefined ? { floristTotal: opts.floristTotal } : {}),
      ...(opts.actualCost !== undefined
        ? { deliveryActualCost: opts.actualCost, deliveryActualCostConfirmedAt: new Date() }
        : {}),
    },
  });
  // Комиссия эквайринга есть у всех: тест про пробел доставки, а не про комиссию.
  await prisma.orderAcquiringFee.create({
    data: { orderId: order.id, feeCents: 300, provider: "TEST", createdBy: "test" },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  // Гейты от дня теста: без них и список, и детектор молчат по построению.
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = DAY_STR;
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = DAY_STR;

  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "INC", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;

  const primaryUser = await prisma.user.create({
    data: { name: "Основной", email: `${RUN}-p@example.com`, role: "FLORIST", passwordHash: "x" },
  });
  const primary = await prisma.florist.create({ data: { userId: primaryUser.id } });
  primaryFloristId = primary.id;
  const primaryProfile = await prisma.floristFinanceProfile.create({
    data: { floristId: primary.id, model: "PRIMARY", sharePercentBp: 6660, active: true, effectiveFrom: DAY, createdBy: "test" },
  });
  primaryProfileId = primaryProfile.id;

  const secondaryUser = await prisma.user.create({
    data: { name: "Второстепенная", email: `${RUN}-s@example.com`, role: "FLORIST", passwordHash: "x" },
  });
  const secondary = await prisma.florist.create({ data: { userId: secondaryUser.id } });
  secondaryFloristId = secondary.id;
  await prisma.floristFinanceProfile.create({
    data: { floristId: secondary.id, model: "SECONDARY", active: true, effectiveFrom: DAY, createdBy: "test" },
  });

  // Ставка расходников на магазин и дневная закупка цветов: единственные пробелы в данных —
  // те, что тест заводит сам.
  await prisma.consumablesRate.create({ data: { siteId, amountCents: 500, createdBy: "test" } });
  await prisma.dailyFlowerExpense.create({
    data: { financeProfileId: primaryProfile.id, expenseDay: DAY, amountCents: 10_000, createdBy: "test" },
  });
});

afterAll(async () => {
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { orderId: { in: orderIds } }] } }).catch(() => {});
  await prisma.orderAcquiringFee.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: primaryProfileId } }).catch(() => {});
  await prisma.consumablesRate.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.floristFinanceProfile
    .deleteMany({ where: { floristId: { in: [primaryFloristId, secondaryFloristId] } } })
    .catch(() => {});
  await prisma.florist.deleteMany({ where: { id: { in: [primaryFloristId, secondaryFloristId] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("три потребителя называют одни и те же заказы", () => {
  it("список, разбор дня и детектор согласны на общих данных", async () => {
    const gapOrder = await makeDelivered(`${RUN}-GAP`, primaryFloristId); // нет фактической доставки
    const noPriceOrder = await makeDelivered(`${RUN}-NOPRICE`, secondaryFloristId, {
      actualCost: "10.00",
      floristTotal: "0.00", // у второстепенного ноль означает «цена не задана»
    });
    const completeOrder = await makeDelivered(`${RUN}-OK`, primaryFloristId, { actualCost: "10.00" });

    // 1. Единый список: ровно два заказа, каждый со своей причиной.
    const shared = (await listIncompleteOrders(DAY, DAY)).filter((o) => orderIds.includes(o.id));
    expect(shared.map((o) => o.id).sort()).toEqual([gapOrder.id, noPriceOrder.id].sort());
    const gapRow = shared.find((o) => o.id === gapOrder.id)!;
    expect(gapRow.missing).toEqual(["DELIVERY_ACTUAL_COST"]);
    expect(gapRow.noFloristPrice).toBe(false);
    const noPriceRow = shared.find((o) => o.id === noPriceOrder.id)!;
    expect(noPriceRow.missing).toEqual([]);
    expect(noPriceRow.noFloristPrice).toBe(true);

    // 2. Разбор дня называет тот же набор с теми же причинами.
    const detail = await getOwnerDay(DAY);
    const detailRows = detail!.incompleteOrders.filter((o) => orderIds.includes(o.id));
    expect(detailRows.map((o) => ({ id: o.id, missing: o.missing, noFloristPrice: o.noFloristPrice }))).toEqual(
      expect.arrayContaining(
        shared.map((o) => ({ id: o.id, missing: o.missing, noFloristPrice: o.noFloristPrice }))
      )
    );
    expect(detailRows).toHaveLength(shared.length);

    // 3. Детектор: на пересечении областей — тот же ответ. Пробел доставки становится
    //    карточкой очереди, полный заказ не упоминается вовсе.
    await detectFinanceIssues();
    const issues = await prisma.financeIssue.findMany({
      where: { orderId: { in: orderIds }, status: "OPEN" },
      select: { orderId: true, type: true },
    });
    expect(issues).toEqual([{ orderId: gapOrder.id, type: "DELIVERY_ACTUAL_COST_MISSING" }]);

    // Пересечение областей формально: заказы основного флориста с пробелами данных.
    const sharedPrimaryGapIds = shared
      .filter((o) => o.missing.length > 0 && o.id !== noPriceOrder.id)
      .map((o) => o.id)
      .sort();
    expect(issues.map((i) => i.orderId).sort()).toEqual(sharedPrimaryGapIds);

    // Различие областей — явное: цена второстепенного не рождает карточку в очереди,
    // а полный заказ не появляется нигде.
    expect(issues.some((i) => i.orderId === noPriceOrder.id)).toBe(false);
    expect(shared.some((o) => o.id === completeOrder.id)).toBe(false);
    expect(detailRows.some((o) => o.id === completeOrder.id)).toBe(false);
  });

  it("заполнение пробела убирает заказ у всех троих разом", async () => {
    const gap = orderIds.length
      ? await prisma.order.findFirst({ where: { orderNumber: `${RUN}-GAP` }, select: { id: true } })
      : null;
    expect(gap).not.toBeNull();

    await prisma.order.update({
      where: { id: gap!.id },
      data: { deliveryActualCost: "12.00", deliveryActualCostConfirmedAt: new Date() },
    });

    const shared = (await listIncompleteOrders(DAY, DAY)).filter((o) => orderIds.includes(o.id));
    expect(shared.some((o) => o.id === gap!.id)).toBe(false);

    const detail = await getOwnerDay(DAY);
    expect(detail!.incompleteOrders.some((o) => o.id === gap!.id)).toBe(false);

    await detectFinanceIssues();
    const open = await prisma.financeIssue.findMany({ where: { orderId: gap!.id, status: "OPEN" } });
    expect(open).toHaveLength(0);
  });
});
