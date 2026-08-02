/**
 * DB integration: ежедневное начисление доли основного флориста.
 *
 * Модель простая и это здесь закреплено: один тип записи, одна дата запуска, ledger
 * показывает рассчитанный долг и денег не переводит. Реальная выплата — только ручной
 * PAYMENT, поэтому пересчёт можно гонять сколько угодно.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/primaryShare.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { accrueDayShare, computeDayShare, primaryShareKey } from "./primaryShare";
import { getFloristBalance } from "./ledger";
import { recordPayment } from "./payouts";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { getShareDayBreakdown } from "./shareView";

const RUN = `psh${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");

let siteId = "";
let floristId = "";
let profileId = "";
let productId = "";
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
  const florist = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  floristId = florist.id;

  const { createdId } = await setFinanceProfile({
    floristId,
    model: "PRIMARY",
    sharePercentBp: 6660,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    actor: OWNER,
  });
  profileId = createdId;

  orderA = await makeOrder("A", 10000);
  orderB = await makeOrder("B", 20000);

  // Заполняем всё, что нужно для расчёта дня.
  await fixConsumablesRate({ siteId: null, amountCents: 500, effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: NOW });
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
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

describe("расчёт дня", () => {
  it("день с блокером не начисляется", async () => {
    // Дневной закупки ещё нет — день заблокирован целиком.
    const r = await accrueDayShare(profileId, DAY, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "DAY_BLOCKED" });
    expect(await prisma.ledgerEntry.count({ where: { floristId, type: "PRIMARY_FLORIST_SHARE" } })).toBe(0);
  });

  it("после заполнения закупки создаётся одно начисление", async () => {
    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });

    const computed = await computeDayShare(profileId, DAY);
    expect(computed!.blocked).toBe(false);
    expect(computed!.ordersCalculable).toBe(2);

    const entries = await prisma.ledgerEntry.findMany({ where: { floristId, type: "PRIMARY_FLORIST_SHARE" } });
    // Начисление уже создано пересчётом внутри fixDailyFlowerExpense.
    expect(entries).toHaveLength(1);
    expect(entries[0].amountCents).toBe(computed!.shareCents);
    expect(entries[0].idempotencyKey).toBe(primaryShareKey(floristId, "2026-07-28"));
  });

  it("чаевые в базу не входят", async () => {
    const b = await getShareDayBreakdown(profileId, DAY, true);
    // Выручка = (100 + 200 товары) + (10 + 10 налог) + (20 + 20 доставка) = 360.00.
    // Чаевые 5.00 + 5.00 отсутствуют.
    expect(b!.lines[0].cents).toBe(36000);
  });

  it("повторный расчёт не создаёт вторую запись", async () => {
    const r = await accrueDayShare(profileId, DAY, OWNER);
    expect(r.status).toBe("UNCHANGED");
    expect(await prisma.ledgerEntry.count({ where: { floristId, type: "PRIMARY_FLORIST_SHARE" } })).toBe(1);
  });

  it("начисление связано с ревизиями снимков, из которых собрано", async () => {
    const entry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE" },
      include: { snapshots: { include: { snapshot: true } } },
    });
    expect(entry.snapshots).toHaveLength(2);
    expect(entry.snapshots.every((s) => s.snapshot.status === "PUBLISHED")).toBe(true);
  });
});

describe("исправление входных данных", () => {
  it("создаёт сторно и новое начисление, не трогая прежнее", async () => {
    const before = await prisma.ledgerEntry.findFirstOrThrow({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", reversal: null },
    });

    // Закупка выросла — распределяемая прибыль падает, доля тоже.
    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 12000, actor: OWNER, now: NOW });

    const original = await prisma.ledgerEntry.findUnique({ where: { id: before.id } });
    expect(original!.amountCents).toBe(before.amountCents);

    const reversal = await prisma.ledgerEntry.findUnique({ where: { reversedEntryId: before.id } });
    expect(reversal?.type).toBe("CORRECTION");
    expect(reversal?.direction).toBe("DEBIT");

    const live = await prisma.ledgerEntry.findMany({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", reversal: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].amountCents).toBeLessThan(before.amountCents);
  });

  it("баланс равен актуальной доле, а не сумме всех записей", async () => {
    const live = await prisma.ledgerEntry.findFirstOrThrow({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", reversal: null },
    });
    const balance = await getFloristBalance(floristId);
    expect(balance.outstandingCents).toBe(live.amountCents);
  });

  it("аудит записан на каждую операцию книги", async () => {
    const entries = await prisma.ledgerEntry.count({ where: { floristId } });
    const audits = await prisma.financeAudit.count({ where: { entity: "LedgerEntry", userId: OWNER.userId } });
    expect(audits).toBe(entries);
  });
});

describe("реальные деньги — только вручную", () => {
  it("начисление не считается выплатой", async () => {
    const balance = await getFloristBalance(floristId);
    expect(balance.paidCents).toBe(0);
    expect(balance.outstandingCents).toBeGreaterThan(0);
  });

  it("после ручной выплаты остаток уменьшается", async () => {
    const before = await getFloristBalance(floristId);
    await recordPayment({
      floristId,
      amountCents: 1000,
      effectiveDate: DAY,
      token: `${RUN}-pay`,
      actor: OWNER,
    });
    const after = await getFloristBalance(floristId);
    expect(after.paidCents).toBe(1000);
    expect(after.outstandingCents).toBe(before.outstandingCents - 1000);
  });

  it("пересчёт доли выплату не трогает", async () => {
    await accrueDayShare(profileId, DAY, OWNER);
    const balance = await getFloristBalance(floristId);
    expect(balance.paidCents).toBe(1000);
  });
});

describe("представления", () => {
  it("флорист не видит происхождение комиссии, владелец видит", async () => {
    const ownerView = await getShareDayBreakdown(profileId, DAY, true);
    const floristView = await getShareDayBreakdown(profileId, DAY, false);

    const feeLine = (b: typeof ownerView) => b!.lines.find((l) => l.label.startsWith("Комиссия эквайринга"))!;
    // У владельца в строке комиссии указано её происхождение, у флориста — нет.
    expect(feeLine(ownerView).label).toMatch(/расчётн|фактическ/i);
    expect(feeLine(floristView).label).toBe("Комиссия эквайринга");
    // Сумма при этом одна и та же: различается представление, а не расчёт.
    expect(feeLine(floristView).cents).toBe(feeLine(ownerView).cents);
    // Суммы при этом одинаковые: модель расчёта одна, различается только представление.
    expect(floristView!.shareCents).toBe(ownerView!.shareCents);
    expect(floristView!.distributableCents).toBe(ownerView!.distributableCents);
  });

  it("в маршруте разбора дня у флориста нет floristId", () => {
    const dir = path.join(process.cwd(), "src/app/dashboard/(florist)/f/finance/day");
    const source = fs.readFileSync(path.join(dir, "[day]", "page.tsx"), "utf8");
    expect(source).toContain("requireFlorist()");
    expect(source).toContain("user.floristId");
    expect(source).not.toMatch(/params.*floristId/);
  });
});

describe("граница периода", () => {
  it("день раньше даты запуска не начисляется", async () => {
    process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-29";
    const r = await accrueDayShare(profileId, DAY, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "BEFORE_START_DATE" });
    process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";
  });

  it("без даты запуска расчёт не идёт", async () => {
    delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
    const r = await accrueDayShare(profileId, DAY, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "NOT_STARTED" });
    process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";
  });
});
