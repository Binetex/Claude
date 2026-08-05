/**
 * DB integration: чтение доли из опубликованного расчёта.
 *
 * Главный инвариант этапа A: путь ЧТЕНИЯ обязан давать те же числа, что даёт живой
 * расчёт, — иначе экран снова сможет разойтись с начислением. Плюс проверяется, что
 * число запросов не растёт с числом дней и что день без снимков честно помечен
 * «не рассчитан», а не показан нулями.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/shareRead.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { computeDayShare } from "./dayFinance";
import { setFinanceProfile } from "./profile";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { readShareDayBreakdown } from "./shareRead";

const RUN = `shr${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const NOW = new Date("2026-07-31T12:00:00.000Z");
const SHARE_START = new Date("2026-07-01T00:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");

/** Три дня: два посчитанных и один без снимков. */
const D1 = new Date("2026-07-28T00:00:00.000Z");
const D2 = new Date("2026-07-29T00:00:00.000Z");
const D3 = new Date("2026-07-30T00:00:00.000Z");

let siteId = "";
let productId = "";
let floristId = "";
let profileId = "";

async function makeOrder(n: string, cents: number, day: Date): Promise<string> {
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
    await setFinanceProfile({ floristId, model: "PRIMARY", effectiveFrom: SHARE_START, sharePercentBp: 6660, actor: OWNER })
  ).createdId;

  const a = await makeOrder("A", 10000, D1);
  const b = await makeOrder("B", 20000, D1);
  const c = await makeOrder("C", 15000, D2);

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });
  for (const id of [a, b, c]) await fixDeliveryActualCost({ orderId: id, amountCents: 1000, actor: OWNER, now: NOW });

  // Заполнение закупки публикует снимки и начисляет долю — это путь ЗАПИСИ.
  await fixDailyFlowerExpense({ expenseDay: D1, amountCents: 6000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: D2, amountCents: 4000, actor: OWNER, now: NOW });

  // Заказ третьего дня создаётся ПОСЛЕ всех правок: правка ставки публикует снимки по
  // всему окну, и созданный раньше заказ получил бы ревизию, а нам нужен день, по
  // которому расчёт не запускался ни разу.
  await makeOrder("D", 12000, D3);
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

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

describe("чтение совпадает с расчётом", () => {
  it("прибыль и доля дня равны живому расчёту до цента", async () => {
    for (const day of [D1, D2]) {
      const computed = await computeDayShare(profileId, day);
      const read = await readShareDayBreakdown(profileId, day);

      expect(read!.calculated).toBe(true);
      expect(read!.distributableCents).toBe(computed!.distributableCents);
      expect(read!.shareCents).toBe(computed!.shareCents);
    }
  });

  it("сумма строк формулы сходится с распределяемой прибылью", async () => {
    const read = await readShareDayBreakdown(profileId, D1);
    const expenses = read!.lines.filter((l) => l.negative).reduce((a, l) => a + l.cents, 0);
    expect(read!.lines[0].cents - expenses).toBe(read!.distributableCents);
  });

});

describe("день без опубликованного расчёта", () => {
  it("разбор такого дня честно говорит, что расчёта нет", async () => {
    const read = await readShareDayBreakdown(profileId, D3);
    expect(read!.calculated).toBe(false);
    expect(read!.lines).toHaveLength(0);
    expect(read!.orders).toHaveLength(0);
  });

  it("просмотр ничего не создаёт", async () => {
    const daysBefore = await prisma.dayFinance.findMany({ select: { day: true, distributableCents: true } });
    const ledgerBefore = await prisma.ledgerEntry.count({ where: { floristId } });

    await readShareDayBreakdown(profileId, D3);
    await readShareDayBreakdown(profileId, D1);

    expect(await prisma.dayFinance.findMany({ select: { day: true, distributableCents: true } })).toEqual(daysBefore);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(ledgerBefore);
  });
});

describe("представления", () => {
  it("представления владельца и флориста совпадают", async () => {
    const owner = await readShareDayBreakdown(profileId, D1);
    const florist = await readShareDayBreakdown(profileId, D1);

    // Единственным различием было происхождение комиссии, а оно жило в позаказном снимке.
    // В дневной строке его нет — представления совпали, и разделять их больше нечем.
    expect(florist!.lines).toEqual(owner!.lines);
    expect(florist!.shareCents).toBe(owner!.shareCents);
  });
});
