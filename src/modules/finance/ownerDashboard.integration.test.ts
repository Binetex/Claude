/**
 * DB integration: дашборд владельца.
 *
 * Главное, что здесь доказывается: дашборд считает ПО ВСЕМ заказам, но заработок флористов
 * берёт из тех же источников, что и выплаты. Если бы он пересчитывал долю основного от
 * своей, более широкой прибыли, кабинет флориста и дашборд показали бы разные деньги — и
 * первый же тест это ловит.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/ownerDashboard.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import { recomputeDay, computeDayShare } from "./dayFinance";
import { getOwnerMonth } from "./ownerDashboard";

const RUN = `own${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-31T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");

let siteId = "";
let productId = "";
let primaryFloristId = "";
let secondaryFloristId = "";
let primaryProfileId = "";
let orderP = "";
let orderS = "";

async function makeOrder(n: string, cents: number, floristId: string, floristTotal: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
      siteId,
      source: "Website",
      externalCreatedAt: DAY,
      deliveryDate: DAY,
      deliveryWindow: "14:00 – 18:00",
      senderName: "S", senderPhone: "+15550000000",
      recipientName: "R", recipientPhone: "+15550000001",
      addressLine: "1 Main St", city: "LA", zip: "90001",
      itemsTotal: (cents / 100).toFixed(2),
      tax: "10.00", tip: "5.00", deliveryCustomerCost: "20.00",
      customerTotal: ((cents + 3500) / 100).toFixed(2),
      floristTotal,
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

async function makeFlorist(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { name, email: `${RUN}-${name}@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  return (await prisma.florist.create({ data: { userId: user.id }, select: { id: true } })).id;
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-07-01";
  process.env.FINANCE_ACCRUAL_ENABLED = "true";

  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-owner@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  siteId = (await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  })).id;

  productId = (await prisma.product.create({
    data: { name: `${RUN} bouquet`, siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
    select: { id: true },
  })).id;

  primaryFloristId = await makeFlorist("Primary");
  secondaryFloristId = await makeFlorist("Secondary");

  primaryProfileId = (
    await setFinanceProfile({ floristId: primaryFloristId, model: "PRIMARY", effectiveFrom: FROM, sharePercentBp: 6660, actor: OWNER })
  ).createdId;
  await setFinanceProfile({ floristId: secondaryFloristId, model: "SECONDARY", effectiveFrom: FROM, actor: OWNER });

  orderP = await makeOrder("P", 10000, primaryFloristId, "0");
  orderS = await makeOrder("S", 30000, secondaryFloristId, "45.00");

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderP, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderS, amountCents: 1500, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });

  // Строка дня основного — именно из неё дашборд обязан брать его долю.
  await recomputeDay(primaryProfileId, DAY, OWNER);
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  delete process.env.FINANCE_ACCRUAL_START_DATE;
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  await prisma.orderAdditionalExpense.deleteMany({ where: { order: { siteId } } });
  await prisma.dayFinance.deleteMany({ where: { financeProfileId: primaryProfileId } });
  await prisma.financeIssue.deleteMany({
    where: { OR: [{ siteId }, { floristId: { in: [primaryFloristId, secondaryFloristId] } }] },
  });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: primaryProfileId } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [primaryFloristId, secondaryFloristId] } } });
  await prisma.florist.deleteMany({ where: { id: { in: [primaryFloristId, secondaryFloristId] } } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe("дашборд владельца", () => {
  it("считает по ВСЕМ заказам, а не по заказам основного флориста", async () => {
    const m = await getOwnerMonth(FROM, TO);
    const day = m.days.find((d) => d.day === "2026-07-28")!;

    // Оба заказа: 100.00 + 30.00 (налог+доставка+чаевые ×2) и 300.00 + 30.00.
    expect(day.ordersTotal).toBe(2);
    expect(day.revenueCents).toBe(10000 + 3500 + 30000 + 3500);
  });

  it("доля основного берётся из его строки дня, а не считается заново", async () => {
    const m = await getOwnerMonth(FROM, TO);
    const day = m.days.find((d) => d.day === "2026-07-28")!;
    const share = await computeDayShare(primaryProfileId, DAY);

    // Ключевой инвариант: дашборд и кабинет флориста показывают одни и те же деньги.
    // Доля считается от прибыли ЕГО заказов, хотя дашборд знает про оба.
    expect(day.floristEarningsCents).toBe(share!.shareCents + 4500);
  });

  it("чистый доход владельца = прибыль всех заказов минус флористы минус мои расходы", async () => {
    const m = await getOwnerMonth(FROM, TO);
    const day = m.days.find((d) => d.day === "2026-07-28")!;

    expect(day.ready).toBe(true);
    expect(day.ownerNetCents).not.toBeNull();
    // Расходов владельца в этом тесте нет, значит чистый = прибыль дня − заработок флористов.
    expect(day.ownerNetCents).toBe(
      day.revenueCents
        - 2 * 500                       // чаевые
        - 2 * 1000                      // налог
        - (1000 + 1500)                 // фактическая доставка
        - (Math.round((13500 * 290) / 10000) + 30 + Math.round((33500 * 290) / 10000) + 30) // эквайринг
        - 2 * 500                       // расходники
        - 6000                          // дневная закупка цветов
        - day.floristEarningsCents
    );
  });

  it("неготовый день не даёт числа и не входит в итог месяца", async () => {
    // Убираем закупку — день перестаёт считаться целиком.
    await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: primaryProfileId } });
    const m = await getOwnerMonth(FROM, TO);
    const day = m.days.find((d) => d.day === "2026-07-28")!;

    expect(day.ready).toBe(false);
    expect(day.ownerNetCents).toBeNull();
    expect(day.blockers).toContain("DAILY_FLOWER_EXPENSE_MISSING");
    // Выручка при этом видна: заказы состоялись, неизвестен только расход.
    expect(day.revenueCents).toBeGreaterThan(0);
    expect(m.ownerNetCents).toBe(0);
    expect(m.incompleteDays).toBe(1);

    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });
    await recomputeDay(primaryProfileId, DAY, OWNER);
  });
});
