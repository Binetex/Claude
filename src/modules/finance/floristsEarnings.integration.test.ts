/**
 * DB integration: обзор заработка флористов по дням.
 *
 * Главное, что здесь проверяется, — обзор НЕ ЗАВОДИТ ВТОРУЮ ФОРМУЛУ. Сумма дней каждого
 * флориста обязана совпадать с `earnedCents` из `balance.ts` до цента: именно это число
 * стоит колонкой «Начислено» в той же таблице, и разойтись они не должны никогда.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/floristsEarnings.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { recomputeDay } from "./dayFinance";
import { floristBalance } from "./balance";
import { getFloristsEarnings } from "./floristsEarnings";

const RUN = `fe${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };

const START = new Date("2026-07-01T00:00:00.000Z");
const DAY1 = new Date("2026-07-10T00:00:00.000Z");
const DAY2 = new Date("2026-07-11T00:00:00.000Z");
/** День, когда никто не работал: он обязан остаться в ряду точек с нулями. */
const GAP = new Date("2026-07-12T00:00:00.000Z");
const DAY3 = new Date("2026-07-13T00:00:00.000Z");
const NOW = new Date("2026-07-20T12:00:00.000Z");

let siteId = "";
let productId = "";
let primaryId = "";
let secondaryId = "";
let profileId = "";

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

  OWNER.userId = (
    await prisma.user.create({
      data: { name: "Owner", email: `${RUN}-o@test.local`, role: "OWNER", passwordHash: "x" },
      select: { id: true },
    })
  ).id;

  siteId = (
    await prisma.site.create({
      data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
      select: { id: true },
    })
  ).id;
  productId = (
    await prisma.product.create({
      data: { name: "B", siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
      select: { id: true },
    })
  ).id;

  const pu = await prisma.user.create({
    data: { name: "Настя", email: `${RUN}-p@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  primaryId = (await prisma.florist.create({ data: { userId: pu.id }, select: { id: true } })).id;
  const su = await prisma.user.create({
    data: { name: "Olga", email: `${RUN}-s@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  secondaryId = (await prisma.florist.create({ data: { userId: su.id }, select: { id: true } })).id;

  profileId = (
    await setFinanceProfile({ floristId: primaryId, model: "PRIMARY", effectiveFrom: START, sharePercentBp: 6660, actor: OWNER })
  ).createdId;
  await setFinanceProfile({ floristId: secondaryId, model: "SECONDARY", effectiveFrom: START, actor: OWNER });

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });

  // Основной: два ПОЛНЫХ дня + один, где не хватает данных. Полный день требует и закупки
  // цветов, и фактической стоимости доставки по каждому заказу.
  const p1 = await makeOrder("p1", 20000, DAY1, primaryId);
  const p2 = await makeOrder("p2", 30000, DAY2, primaryId);
  await makeOrder("p3", 25000, DAY3, primaryId);
  await fixDailyFlowerExpense({ expenseDay: DAY1, amountCents: 6000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY2, amountCents: 7000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: p1, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: p2, amountCents: 1200, actor: OWNER, now: NOW });
  // У DAY3 нет ни закупки цветов, ни стоимости доставки — день останется неполным.
  await recomputeDay(profileId, DAY1, OWNER);
  await recomputeDay(profileId, DAY2, OWNER);
  await recomputeDay(profileId, DAY3, OWNER);

  // Второстепенный: два заказа с ценой и один без — последний в заработок не входит.
  await makeOrder("s1", 15000, DAY1, secondaryId, "118.00");
  await makeOrder("s2", 16000, DAY3, secondaryId, "125.00");
  await makeOrder("s3", 14000, DAY3, secondaryId);
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;

  await prisma.dayFinance.deleteMany({ where: { financeProfileId: profileId } });
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
  await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}-` } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

const sumDays = (points: { [k: string]: number | string }[], floristId: string) =>
  points.reduce((a, p) => a + (Number(p[floristId]) || 0), 0);

describe("getFloristsEarnings — обзор не заводит вторую формулу", () => {
  it("сумма дней основного = earnedCents из balance.ts", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    const balance = await floristBalance(primaryId);
    expect(sumDays(data.points, primaryId)).toBe(balance.earnedCents);
    expect(data.byFlorist.get(primaryId)!.earnedCents).toBe(balance.earnedCents);
  });

  it("сумма дней второстепенного = earnedCents из balance.ts", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    const balance = await floristBalance(secondaryId);
    expect(sumDays(data.points, secondaryId)).toBe(balance.earnedCents);
    expect(data.byFlorist.get(secondaryId)!.earnedCents).toBe(balance.earnedCents);
  });

  it("итог сверху = сумма всех флористов", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    const perFlorist = [...data.byFlorist.values()].reduce((a, r) => a + r.earnedCents, 0);
    expect(data.earnedCents).toBe(perFlorist);
    expect(data.earnedCents).toBe(data.points.reduce((a, p) => a + p.total, 0));
  });
});

describe("что в обзор не входит", () => {
  it("неполный день не даёт ни заработка, ни заказов", async () => {
    // Иначе средний заработок на заказ был бы занижен: заказы есть, денег за них ещё нет.
    const data = await getFloristsEarnings(DAY3, DAY3);
    expect(data.pending.days).toBe(1);
    const point = data.points.find((p) => p.day === "2026-07-13")!;
    expect(Number(point[primaryId] ?? 0)).toBe(0);
  });

  it("заказ без цены флориста не входит в заработок и виден отдельно", async () => {
    const data = await getFloristsEarnings(DAY3, DAY3);
    expect(data.pending.orders).toBe(1);
    // При этом заказ С ценой того же дня посчитан.
    expect(data.byFlorist.get(secondaryId)!.orders).toBe(1);
  });
});

describe("ряд дней и серии", () => {
  it("день без работы остаётся в ряду с нулями — ось времени не рвётся", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    expect(data.points.map((p) => p.day)).toEqual(["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]);
    const gap = data.points.find((p) => p.day === "2026-07-12")!;
    expect(gap.total).toBe(0);
    expect(gap.orders).toBe(0);
  });

  it("у каждого флориста в серии свой цвет", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    const mine = data.series.filter((s) => [primaryId, secondaryId].includes(s.floristId));
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((s) => s.color)).size).toBe(2);
  });

  it("цвет флориста не зависит от выбранного периода", async () => {
    // Иначе при смене дат цвета «скачут»: выпавший из серии перекрашивает следующих.
    const wide = await getFloristsEarnings(DAY1, DAY3);
    const narrow = await getFloristsEarnings(DAY1, DAY1);
    const colorOf = (d: { series: { floristId: string; color: string }[] }, id: string) =>
      d.series.find((s) => s.floristId === id)?.color;
    expect(colorOf(narrow, primaryId)).toBe(colorOf(wide, primaryId));
    expect(colorOf(narrow, secondaryId)).toBe(colorOf(wide, secondaryId));
  });

  it("средний заработок на заказ — заработок делить на заказы, без деления на ноль", async () => {
    const data = await getFloristsEarnings(DAY1, DAY3);
    expect(data.avgCents).toBe(Math.round(data.earnedCents / data.ordersTotal));
    const empty = await getFloristsEarnings(GAP, GAP);
    expect(empty.ordersTotal).toBe(0);
    expect(empty.avgCents).toBe(0);
  });
});
