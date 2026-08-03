/**
 * DB integration: сбор и запись финансового итога дня.
 *
 * Главное, что здесь доказывается: **плоская формула даёт ровно тот же результат, что
 * прежняя с распределением дневной закупки по заказам**. Если это так, распределение было
 * накладными расходами, и его можно снимать без последствий для денег.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/dayFinance.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { computeDayShare } from "./primaryShare";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { addOrderExpense } from "./orderExpenses";
import { computeDay, readDay, recomputeDay } from "./dayFinance";
import { dayShareCents } from "./dayCalc";

const RUN = `dfn${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");

let siteId = "";
let productId = "";
let floristId = "";
let profileId = "";
let orderA = "";
let orderB = "";

async function makeOrder(n: string, cents: number): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
      siteId,
      source: "Website",
      externalCreatedAt: DAY,
      deliveryDate: DAY,
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
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";

  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-owner@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  const site = await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  });
  siteId = site.id;

  const product = await prisma.product.create({
    data: { name: `${RUN} bouquet`, siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
    select: { id: true },
  });
  productId = product.id;

  const user = await prisma.user.create({
    data: { name: "Nastya", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  floristId = (await prisma.florist.create({ data: { userId: user.id }, select: { id: true } })).id;

  profileId = (
    await setFinanceProfile({ floristId, model: "PRIMARY", sharePercentBp: 6660, effectiveFrom: START, actor: OWNER })
  ).createdId;

  // Разные суммы заказов: при распределении их доли закупки различались бы, и если бы
  // формулы расходились, это бы вылезло именно здесь.
  orderA = await makeOrder("A", 10000);
  orderB = await makeOrder("B", 30000);

  await fixConsumablesRate({ siteId: null, amountCents: 500, effectiveFrom: START, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, effectiveFrom: START, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderB, amountCents: 1500, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.orderAdditionalExpense.deleteMany({ where: { order: { siteId } } });
  await prisma.dayFinance.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.ledgerEntrySnapshot.deleteMany({ where: { ledgerEntry: { floristId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" DISABLE TRIGGER USER`);
  await prisma.orderFinancialSnapshot.deleteMany({ where: { order: { siteId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: floristId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("плоская формула против распределения", () => {
  it("даёт ту же прибыль и ту же долю до цента", async () => {
    const flat = await computeDay(profileId, DAY);
    const old = await computeDayShare(profileId, DAY);

    expect(flat!.complete).toBe(true);
    expect(flat!.distributableCents).toBe(old!.distributableCents);
    expect(dayShareCents(flat!.distributableCents, 6660)).toBe(old!.shareCents);
  });

  it("совпадение сохраняется и после дополнительного расхода по заказу", async () => {
    const added = await addOrderExpense({
      orderId: orderB,
      amountCents: 4321,
      description: "Повторная доставка",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    const flat = await computeDay(profileId, DAY);
    const old = await computeDayShare(profileId, DAY);
    expect(flat!.additionalCents).toBe(4321);
    expect(flat!.distributableCents).toBe(old!.distributableCents);

    await prisma.orderAdditionalExpense.delete({ where: { id: added.expenseId } });
  });
});

describe("состав дня", () => {
  it("дневная закупка вычитается один раз и видна отдельной величиной", async () => {
    const d = await computeDay(profileId, DAY);
    expect(d!.flowerPurchaseCents).toBe(6000);
    // Сумма вкладов заказов минус закупка.
    const contributions = d!.orders.reduce((a, o) => a + o.contributionCents, 0);
    expect(d!.distributableCents).toBe(contributions - 6000);
  });

  it("чаевые входят в выручку и вычитаются той же величиной", async () => {
    const d = await computeDay(profileId, DAY);
    expect(d!.tipsCents).toBe(1000); // 5.00 × 2 заказа
  });
});

describe("запись дня", () => {
  it("пересчёт создаёт строку, повторный — перезаписывает её, а не плодит вторую", async () => {
    await recomputeDay(profileId, DAY, OWNER);
    const first = await readDay(profileId, DAY);
    expect(first).not.toBeNull();
    expect(first!.complete).toBe(true);

    await recomputeDay(profileId, DAY, OWNER);
    expect(await prisma.dayFinance.count({ where: { financeProfileId: profileId } })).toBe(1);

    const second = await readDay(profileId, DAY);
    expect(second!.id).toBe(first!.id);
    expect(second!.distributableCents).toBe(first!.distributableCents);
  });

  it("изменение входных данных перезаписывает ту же строку новым числом", async () => {
    const before = await readDay(profileId, DAY);
    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 9000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY, OWNER);

    const after = await readDay(profileId, DAY);
    expect(after!.id).toBe(before!.id);
    // Закупка выросла на 30.00 — ровно на столько упала прибыль.
    expect(before!.distributableCents - after!.distributableCents).toBe(3000);

    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY, OWNER);
  });

  it("неполный день пишется без прибыли — это проверяет и CHECK в базе", async () => {
    await prisma.order.update({
      where: { id: orderA },
      data: { deliveryActualCost: "0.00", deliveryActualCostConfirmedAt: null },
    });

    const d = await recomputeDay(profileId, DAY, OWNER);
    expect(d!.complete).toBe(false);
    expect(d!.blockers).toContain("ORDER_DATA_INCOMPLETE");
    expect(d!.distributableCents).toBe(0);

    const row = await readDay(profileId, DAY);
    expect(row!.complete).toBe(false);
    expect(row!.distributableCents).toBe(0);
    // Суммы строк при этом собраны: их показывают, просто не начисляют.
    expect(row!.grossRevenueCents).toBeGreaterThan(0);

    await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY, OWNER);
  });
});
