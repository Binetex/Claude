/**
 * DB integration: долг флористу без хранимых начислений.
 *
 * Проверяется главный принцип перестройки: заработок ВЫВОДИТСЯ из данных, а записываются
 * только решения владельца — выплаты, бонусы, корректировки. Пересчитался день — долг
 * изменился сам, без сторно и корректировок в книге.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/balance.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { addOrderExpense } from "./orderExpenses";
import { recomputeDay } from "./dayFinance";
import { dayShareCents } from "./dayCalc";
import { floristBalance } from "./balance";
import { previewPayment } from "./payouts";
import { appendEntry } from "./ledger";
import { manualKey } from "./ledgerRules";

const RUN = `bal${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");
const SHARE_START = new Date("2026-07-01T00:00:00.000Z");
const DAY2 = new Date("2026-07-29T00:00:00.000Z");
const NOW = new Date("2026-07-30T12:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");

let siteId = "";
let productId = "";
let primaryId = "";
let secondaryId = "";
let profileId = "";
let orderA = "";
let secondOrder = "";

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
  const product = await prisma.product.create({
    data: { name: "B", siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
    select: { id: true },
  });
  productId = product.id;

  const pu = await prisma.user.create({
    data: { name: "Nastya", email: `${RUN}-p@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  primaryId = (await prisma.florist.create({ data: { userId: pu.id }, select: { id: true } })).id;
  const su = await prisma.user.create({
    data: { name: "Olga", email: `${RUN}-s@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  secondaryId = (await prisma.florist.create({ data: { userId: su.id }, select: { id: true } })).id;

  profileId = (
    await setFinanceProfile({ floristId: primaryId, model: "PRIMARY", effectiveFrom: SHARE_START, sharePercentBp: 6660, actor: OWNER })
  ).createdId;
  await setFinanceProfile({ floristId: secondaryId, model: "SECONDARY", effectiveFrom: SHARE_START, actor: OWNER });

  orderA = await makeOrder("A", 20000, DAY, primaryId);
  secondOrder = await makeOrder("S", 15000, DAY, secondaryId, "118.00");

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });

  await recomputeDay(profileId, DAY, OWNER);
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
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("основной флорист", () => {
  it("заработок выводится из посчитанных дней, а не из записей книги", async () => {
    const day = await prisma.dayFinance.findFirstOrThrow({ where: { financeProfileId: profileId } });
    const b = await floristBalance(primaryId, NOW);

    expect(b.model).toBe("PRIMARY");
    expect(b.earnedCents).toBe(dayShareCents(day.distributableCents, 6660));
    expect(b.outstandingCents).toBe(b.earnedCents);
    expect(b.detail.days).toBe(1);

    // Начислений в книге больше не существует вовсе: заработок считается на лету.
    const legacy = await prisma.ledgerEntry.count({
      where: { floristId: primaryId, type: "PRIMARY_FLORIST_SHARE" },
    });
    expect(legacy).toBe(0);
  });

  it("пересчёт дня меняет долг сам — без сторно и корректировок", async () => {
    const before = await floristBalance(primaryId, NOW);
    const decided = () =>
      prisma.ledgerEntry.count({
        where: { floristId: primaryId, type: { in: ["PAYMENT", "BONUS", "MANUAL_ADJUSTMENT"] } },
      });
    const decidedBefore = await decided();

    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 9000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY, OWNER);

    const after = await floristBalance(primaryId, NOW);
    // Закупка выросла на 30.00 → прибыль дня упала на 30.00 → доля на 66.6% от этого.
    expect(before.earnedCents - after.earnedCents).toBe(dayShareCents(3000, 6660));
    // Решений владельца при этом не прибавилось: долг изменился сам, без сторно и
    // корректировок. Это и есть смысл выводимого заработка.
    expect(await decided()).toBe(decidedBefore);

    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY, OWNER);
  });

  it("неполный день в заработок не входит", async () => {
    const orderB = await makeOrder("B", 10000, DAY2, primaryId);
    await fixDailyFlowerExpense({ expenseDay: DAY2, amountCents: 4000, actor: OWNER, now: NOW });
    // Доставка не подтверждена — день неполный.
    await recomputeDay(profileId, DAY2, OWNER);

    const b = await floristBalance(primaryId, NOW);
    expect(b.detail.days).toBe(1); // только первый день

    await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY2, OWNER);

    const after = await floristBalance(primaryId, NOW);
    expect(after.detail.days).toBe(2);
    expect(after.earnedCents).toBeGreaterThan(b.earnedCents);
  });

  it("убыточный день не съедает заработок соседних", async () => {
    // Отсечка «не ниже нуля» применяется к каждому дню отдельно.
    await fixDailyFlowerExpense({ expenseDay: DAY2, amountCents: 500000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY2, OWNER);

    const day1 = await prisma.dayFinance.findFirstOrThrow({ where: { financeProfileId: profileId, day: DAY } });
    const b = await floristBalance(primaryId, NOW);
    expect(b.earnedCents).toBe(dayShareCents(day1.distributableCents, 6660));

    await fixDailyFlowerExpense({ expenseDay: DAY2, amountCents: 4000, actor: OWNER, now: NOW });
    await recomputeDay(profileId, DAY2, OWNER);
  });
});

describe("второстепенный флорист", () => {
  it("заработок — сумма фиксированных цен доставленных заказов", async () => {
    const b = await floristBalance(secondaryId, NOW);
    expect(b.model).toBe("SECONDARY");
    expect(b.earnedCents).toBe(11800);
    expect(b.outstandingCents).toBe(11800);
  });

  it("дополнительный расход уменьшает долг доллар в доллар", async () => {
    await addOrderExpense({
      orderId: secondOrder,
      amountCents: 3000,
      description: "Повторная доставка",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    const b = await floristBalance(secondaryId, NOW);
    expect(b.deductionCents).toBe(3000);
    expect(b.outstandingCents).toBe(8800); // 118.00 − 30.00
  });

  it("расход больше заработка уводит долг в минус и не обнуляется", async () => {
    const big = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 12000,
      description: "Компенсация",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    expect((await floristBalance(secondaryId, NOW)).outstandingCents).toBe(-3200);

    await prisma.orderAdditionalExpense.update({
      where: { id: big.expenseId },
      data: { reversedAt: new Date(), reversedBy: OWNER.userId, reversalReason: "откат" },
    });
    expect((await floristBalance(secondaryId, NOW)).outstandingCents).toBe(8800);
  });
});

describe("записанные решения владельца", () => {
  it("выплата уменьшает долг и остаётся фактом", async () => {
    const before = await floristBalance(secondaryId, NOW);

    await appendEntry({
      floristId: secondaryId,
      type: "PAYMENT",
      amountCents: 5000,
      effectiveDate: NOW,
      description: "Выплата",
      sourceType: "MANUAL",
      idempotencyKey: manualKey("PAYMENT", secondaryId, "t1"),
      actor: OWNER,
    });

    const after = await floristBalance(secondaryId, NOW);
    expect(after.paidCents).toBe(5000);
    expect(after.outstandingCents).toBe(before.outstandingCents - 5000);
  });

  it("бонус увеличивает долг", async () => {
    const before = await floristBalance(secondaryId, NOW);
    await appendEntry({
      floristId: secondaryId,
      type: "BONUS",
      amountCents: 2000,
      effectiveDate: NOW,
      description: "Бонус",
      sourceType: "MANUAL",
      idempotencyKey: manualKey("BONUS", secondaryId, "t2"),
      actor: OWNER,
    });

    const after = await floristBalance(secondaryId, NOW);
    expect(after.bonusCents).toBe(2000);
    expect(after.outstandingCents).toBe(before.outstandingCents + 2000);
  });
});

describe("один источник долга на весь модуль", () => {
  /**
   * Регрессия. Экраны флористов и проверка выплаты когда-то считали остаток по книге
   * (foldBalance), а страница доли — по дневным итогам. Пока в книге лежали начисления,
   * числа совпадали; когда начисления исчезли, экраны стали показывать устаревшую сумму,
   * а страница доли — настоящую. Разойтись они не должны нигде.
   */
  it("предпросмотр выплаты считает остаток тем же способом, что и экраны", async () => {
    const balance = await floristBalance(primaryId, NOW);
    const preview = await previewPayment(primaryId, 1000);

    expect(preview.outstandingBeforeCents).toBe(balance.outstandingCents);
    expect(preview.outstandingAfterCents).toBe(balance.outstandingCents - 1000);
  });

  it("старые записи начислений в книге на остаток не влияют", async () => {
    const before = await floristBalance(primaryId, NOW);

    // Ровно та ситуация, что осталась на проде: начисления прошлой модели лежат в книге.
    await appendEntry({
      floristId: primaryId,
      type: "PRIMARY_FLORIST_SHARE",
      amountCents: 99999,
      effectiveDate: NOW,
      description: "Начисление прошлой модели",
      sourceType: "MANUAL",
      idempotencyKey: manualKey("LEGACY", primaryId, "t1"),
      actor: OWNER,
    });

    const after = await floristBalance(primaryId, NOW);
    expect(after.outstandingCents).toBe(before.outstandingCents);
    expect((await previewPayment(primaryId, 0)).outstandingBeforeCents).toBe(before.outstandingCents);
  });
});
