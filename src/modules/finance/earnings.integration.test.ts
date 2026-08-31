/**
 * DB integration: заработок в кабинете флориста.
 *
 * Главное, что здесь проверяется, — сумма дней на экране СХОДИТСЯ с «К выплате» из
 * balance.ts до цента. Это не украшение: второй способ посчитать деньги уже приводил к
 * тому, что два экрана показывали разные числа, и именно поэтому earnings.ts обязан
 * повторять правила balance.ts, а не изобретать свои.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/earnings.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { addOrderExpense } from "./orderExpenses";
import { recomputeDay } from "./dayFinance";
import { floristBalance } from "./balance";
import { floristEarningsRange, floristDayOrders, floristEarningTotals, dayFromKey } from "./earnings";

const RUN = `ern${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const START = new Date("2026-07-01T00:00:00.000Z");
const DAY1 = new Date("2026-07-28T00:00:00.000Z");
const DAY2 = new Date("2026-07-29T00:00:00.000Z");
/** День РАНЬШЕ даты старта: в заработок попадать не должен ни при каких условиях. */
const BEFORE_START = new Date("2026-06-20T00:00:00.000Z");
const NOW = new Date("2026-07-30T12:00:00.000Z");

let siteId = "";
let productId = "";
let primaryId = "";
let secondaryId = "";
let profileId = "";
let primaryOrder = "";
let secOrderDay1 = "";
let secOrderDay1b = "";

async function makeOrder(n: string, cents: number, day: Date, floristId: string, floristTotal?: string) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
      siteId,
      source: "Website",
      externalCreatedAt: day,
      deliveryDate: day,
      deliveryWindow: "14:00 – 18:00",
      senderName: "S",
      senderPhone: "+15550000000",
      recipientName: "R",
      recipientPhone: "+15550000001",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: (cents / 100).toFixed(2),
      tax: "10.00",
      tip: "5.00",
      deliveryCustomerCost: "20.00",
      customerTotal: ((cents + 3500) / 100).toFixed(2),
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      ...(floristTotal ? { priceMode: "MANUAL" as const, floristTotal } : {}),
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-07-01";

  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-o@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  const site = await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  });
  siteId = site.id;
  productId = (
    await prisma.product.create({
      data: { name: "B", siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
      select: { id: true },
    })
  ).id;

  const pu = await prisma.user.create({
    data: { name: "Primary", email: `${RUN}-p@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  primaryId = (await prisma.florist.create({ data: { userId: pu.id }, select: { id: true } })).id;
  const su = await prisma.user.create({
    data: { name: "Secondary", email: `${RUN}-s@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  secondaryId = (await prisma.florist.create({ data: { userId: su.id }, select: { id: true } })).id;

  profileId = (
    await setFinanceProfile({ floristId: primaryId, model: "PRIMARY", effectiveFrom: START, sharePercentBp: 6660, actor: OWNER })
  ).createdId;
  await setFinanceProfile({ floristId: secondaryId, model: "SECONDARY", effectiveFrom: START, actor: OWNER });

  primaryOrder = await makeOrder("P1", 20000, DAY1, primaryId);
  secOrderDay1 = await makeOrder("S1", 15000, DAY1, secondaryId, "118.00");
  secOrderDay1b = await makeOrder("S2", 12000, DAY1, secondaryId, "90.00");
  await makeOrder("S3", 10000, DAY2, secondaryId, "70.00");
  // Заказ ДО даты старта — не должен попасть ни в один период.
  await makeOrder("S0", 9000, BEFORE_START, secondaryId, "60.00");

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: primaryOrder, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY1, amountCents: 6000, actor: OWNER, now: NOW });

  // Доп. расход по одному заказу: он уменьшает заработок второстепенного доллар в доллар.
  // Строго ПОСЛЕ настроек дня: addOrderExpense сам запускает пересчёт, и на пустых
  // настройках день ушёл бы в блокеры.
  await addOrderExpense({ orderId: secOrderDay1, amountCents: 1800, description: "Переделка", expenseDate: DAY1, actor: OWNER, now: NOW });

  await recomputeDay(profileId, DAY1, OWNER);
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;

  await prisma.orderAdditionalExpense.deleteMany({ where: { order: { siteId } } });
  await prisma.dayFinance.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [primaryId, secondaryId] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId: { in: [primaryId, secondaryId] } }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [primaryId, secondaryId] } } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [primaryId, secondaryId] } } });
  await prisma.user.deleteMany({ where: { email: { contains: RUN } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("заработок второстепенного флориста", () => {
  it("дни собираются из доставленных заказов, расход вычтен из своего дня", async () => {
    const r = await floristEarningsRange(secondaryId, START, DAY2);
    expect(r.days.map((d) => d.day)).toEqual(["2026-07-29", "2026-07-28"]);
    // 28-е: 118.00 − 18.00 расхода + 90.00 = 190.00; 29-е: 70.00.
    expect(r.days.find((d) => d.day === "2026-07-28")!.cents).toBe(19000);
    expect(r.days.find((d) => d.day === "2026-07-29")!.cents).toBe(7000);
    expect(r.cents).toBe(26000);
    expect(r.orders).toBe(3);
  });

  it("сумма дней сходится с «К выплате» до цента", async () => {
    const [r, b] = await Promise.all([
      floristEarningsRange(secondaryId, START, DAY2),
      floristBalance(secondaryId),
    ]);
    expect(r.cents).toBe(b.earnedCents - b.deductionCents);
    expect(b.outstandingCents).toBe(r.cents); // выплат, бонусов и корректировок нет
  });

  it("заказ раньше даты старта не попадает в заработок даже при широком периоде", async () => {
    const r = await floristEarningsRange(secondaryId, BEFORE_START, DAY2);
    expect(r.days.some((d) => d.day === "2026-06-20")).toBe(false);
    expect(r.cents).toBe(26000);
  });

  it("заказы дня показываются со своими суммами и пометкой о расходе", async () => {
    const { orders, totalCents } = await floristDayOrders(secondaryId, DAY1);
    expect(totalCents).toBe(19000);
    const withExpense = orders.find((o) => o.orderId === secOrderDay1)!;
    expect([withExpense.cents, withExpense.adjusted]).toEqual([10000, true]);
    expect(orders.find((o) => o.orderId === secOrderDay1b)!.adjusted).toBe(false);
  });
});

describe("заработок основного флориста", () => {
  it("посчитанный день даёт долю и сходится с «К выплате»", async () => {
    const row = await prisma.dayFinance.findFirst({ where: { financeProfileId: profileId } });
    const [r, b] = await Promise.all([floristEarningsRange(primaryId, START, DAY2), floristBalance(primaryId)]);
    expect({ complete: row?.complete, blockers: row?.blockers }).toEqual({ complete: true, blockers: [] });
    expect(r.days).toHaveLength(1);
    expect(r.days[0].day).toBe("2026-07-28");
    expect(r.cents).toBe(b.earnedCents);
    expect(r.cents).toBeGreaterThan(0);
  });

  it("непосчитанный день в списке не появляется и заработка не даёт", async () => {
    // DAY2 у основного не считался вовсе — строки DayFinance нет.
    const r = await floristEarningsRange(primaryId, DAY2, DAY2);
    expect(r).toEqual({ cents: 0, orders: 0, days: [] });
  });

  it("неполный день не даёт заработка и в список не попадает", async () => {
    const key = { financeProfileId_day: { financeProfileId: profileId, day: DAY1 } };
    const before = await prisma.dayFinance.findUniqueOrThrow({ where: key });
    // Неполный день по построению не имеет распределяемой прибыли — это гарантирует и
    // check-констрейнт DF_incomplete_has_no_profit. Воспроизводим ровно такую строку.
    await prisma.dayFinance.update({ where: key, data: { complete: false, distributableCents: 0 } });

    const r = await floristEarningsRange(primaryId, START, DAY2);
    expect(r).toEqual({ cents: 0, orders: 0, days: [] });

    await prisma.dayFinance.update({
      where: key,
      data: { complete: true, distributableCents: before.distributableCents },
    });
  });
});

describe("итоги для карточек", () => {
  it("«за всё время» покрывает все посчитанные дни, «сегодня» пуст — заказов сегодня нет", async () => {
    const totals = await floristEarningTotals(secondaryId, NOW);
    expect(totals.allTime.cents).toBe(26000);
    expect(totals.allTime.orders).toBe(3);
    expect(totals.today).toEqual({ cents: 0, orders: 0 });
  });

  it("«за месяц» берёт текущий календарный месяц", async () => {
    const totals = await floristEarningTotals(secondaryId, NOW); // NOW = 30 июля
    expect(totals.month.cents).toBe(26000);
  });

  it("день без данных отдаёт пустой список заказов", async () => {
    const { orders, totalCents } = await floristDayOrders(secondaryId, dayFromKey("2026-07-01"));
    expect([orders.length, totalCents]).toEqual([0, 0]);
  });
});
