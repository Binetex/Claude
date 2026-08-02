/**
 * DB integration: Finance Setup Assistant на ЖИВОЙ базе.
 *
 * Проверяет то, чего не покажут чистые функции: жизненный цикл ревизий снимка,
 * идемпотентность детектора, что предпросмотр действительно ничего не пишет, и что
 * исправление публикует НОВУЮ ревизию, не трогая прежнюю.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/stage3a.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { buildDayPlan, publishDaySnapshots } from "./snapshot";
import { detectFinanceIssues, listOpenIssues } from "./issues";
import { previewDay } from "./preview";
import {
  FinanceFixError,
  fixConsumablesRate,
  fixDailyFlowerExpense,
  fixDeliveryActualCost,
  fixSiteFeeModel,
} from "./fix";

const RUN = `s3a${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");

let siteId = "";
let floristId = "";
let profileId = "";
let orderA = "";
let orderB = "";

async function makeOrder(n: string, flowerCents: number): Promise<string> {
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
      itemsTotal: (flowerCents / 100).toFixed(2),
      tax: "10.00",
      deliveryCustomerCost: "20.00",
      customerTotal: ((flowerCents + 3000) / 100).toFixed(2),
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      items: {
        // Позиция без связи с каталогом трактовалась бы как «тип неизвестен» и блокировала
        // бы день, поэтому в фикстуре она привязана к товару.
        create: [{ name: "Bouquet", quantity: 1, externalPrice: (flowerCents / 100).toFixed(2), productId: productId }],
      },
    },
    select: { id: true },
  });
  return o.id;
}

let productId = "";

beforeAll(async () => {
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
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    actor: OWNER,
  });
  profileId = createdId;

  orderA = await makeOrder("A", 10000);
  orderB = await makeOrder("B", 20000);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" DISABLE TRIGGER USER`);
  await prisma.orderFinancialSnapshot.deleteMany({ where: { orderId: { in: [orderA, orderB] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.consumablesRate.deleteMany({ where: { OR: [{ siteId }, { siteId: null }] } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.ownerTaxPolicy.deleteMany({ where: { OR: [{ siteId }, { siteId: null }] } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: [orderA, orderB] } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.productVariant.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: floristId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("детектор", () => {
  it("находит недостающие данные и не плодит дубли при повторе", async () => {
    const first = await detectFinanceIssues(new Date("2026-07-29T12:00:00.000Z"));
    expect(first.opened).toBeGreaterThan(0);

    const second = await detectFinanceIssues(new Date("2026-07-29T12:00:00.000Z"));
    expect(second.opened).toBe(0);
    expect(second.updated).toBe(first.opened);

    const open = await listOpenIssues();
    const types = open.map((i) => i.type);
    expect(types).toContain("DAILY_FLOWER_EXPENSE_MISSING");
    expect(types).toContain("ACQUIRING_FEE_MODEL_MISSING");
    expect(types).toContain("CONSUMABLES_RATE_MISSING");
    // Ключи уникальны — иначе повторный прогон создал бы вторую строку.
    expect(new Set(open.map((i) => i.deduplicationKey)).size).toBe(open.length);
  });
});

describe("предпросмотр", () => {
  it("ничего не пишет в базу", async () => {
    const before = await Promise.all([
      prisma.orderFinancialSnapshot.count(),
      prisma.dailyFlowerExpense.count(),
      prisma.consumablesRate.count(),
      prisma.siteAcquiringFeeModel.count(),
    ]);

    const preview = await previewDay(profileId, DAY, {
      dailyExpenseCents: 12000,
      consumablesCentsBySite: { [siteId]: 500 },
      feeModelBySite: { [siteId]: { percentBp: 290, fixedCents: 30 } },
      deliveryActualCentsByOrder: { [orderA]: 1000, [orderB]: 1000 },
    });
    expect(preview).not.toBeNull();
    // Знаменатель полный: 100.00 + 200.00 цветочной выручки.
    expect(preview!.denominatorCents).toBe(30000);
    expect(preview!.calculableAfter).toBe(2);

    const after = await Promise.all([
      prisma.orderFinancialSnapshot.count(),
      prisma.dailyFlowerExpense.count(),
      prisma.consumablesRate.count(),
      prisma.siteAcquiringFeeModel.count(),
    ]);
    expect(after).toEqual(before);
  });
});

describe("жизненный цикл ревизий", () => {
  it("исправления публикуют ревизии, а прежние становятся SUPERSEDED и не меняются", async () => {
    await fixConsumablesRate({ siteId: null, amountCents: 500, effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });
    await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });
    await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });
    await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });

    // Пока нет дневной закупки — день не считается целиком.
    const beforeExpense = await buildDayPlan(profileId, DAY);
    expect(beforeExpense!.result.blockers).toContain("DAILY_FLOWER_EXPENSE_MISSING");

    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 12000, actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });

    const published = await prisma.orderFinancialSnapshot.findMany({
      where: { orderId: orderA },
      orderBy: { revision: "asc" },
    });
    expect(published.length).toBeGreaterThan(1);
    expect(published.filter((r) => r.status === "PUBLISHED")).toHaveLength(1);
    expect(published.filter((r) => r.status === "SUPERSEDED").length).toBeGreaterThan(0);

    const current = published.find((r) => r.status === "PUBLISHED")!;
    expect(current.isCalculable).toBe(true);
    // 100.00 цветов из 300.00 знаменателя → треть от 120.00 закупки.
    expect(current.allocatedFlowerCents).toBe(4000);

    // Вытесненная ревизия неизменяема.
    const superseded = published.find((r) => r.status === "SUPERSEDED")!;
    await expect(
      prisma.orderFinancialSnapshot.update({ where: { id: superseded.id }, data: { distributableCents: 1 } })
    ).rejects.toThrow(/immutable|PUBLISHED→SUPERSEDED/i);
    await expect(prisma.orderFinancialSnapshot.delete({ where: { id: superseded.id } })).rejects.toThrow(/cannot be deleted/i);
  });

  it("вход расчёта сохранён целиком и объясняет расчёт без текущих настроек", async () => {
    const current = await prisma.orderFinancialSnapshot.findFirst({ where: { orderId: orderA, status: "PUBLISHED" } });
    const input = current!.calcInputJson as Record<string, Record<string, unknown>>;
    expect(input.order.number).toBe(`${RUN}-A`);
    expect(input.day.denominatorCents).toBe(30000);
    expect(input.day.dailyExpenseCents).toBe(12000);
    expect(input.settings.feeModelId).toBeTruthy();
    expect(input.settings.consumablesRateId).toBeTruthy();
    expect(Array.isArray(input.items)).toBe(true);
  });

  it("повторная публикация без изменений не создаёт ревизию", async () => {
    const before = await prisma.orderFinancialSnapshot.count({ where: { orderId: orderA } });
    const r = await publishDaySnapshots(profileId, DAY, OWNER);
    expect(r.published).toBe(0);
    const after = await prisma.orderFinancialSnapshot.count({ where: { orderId: orderA } });
    expect(after).toBe(before);
  });

  it("детектор закрывает исчезнувшие проблемы как AUTO_RESOLVED", async () => {
    await detectFinanceIssues(new Date("2026-07-29T12:00:00.000Z"));
    const resolved = await prisma.financeIssue.findMany({
      where: { floristId, status: "AUTO_RESOLVED" },
      select: { type: true, resolvedAt: true },
    });
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((r) => r.resolvedAt != null)).toBe(true);

    const open = await listOpenIssues();
    expect(open.map((i) => i.type)).not.toContain("DAILY_FLOWER_EXPENSE_MISSING");
  });

  it("повторная отправка того же исправления идемпотентна по результату", async () => {
    const before = await prisma.orderFinancialSnapshot.count({ where: { orderId: orderA } });
    await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 12000, actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") });
    const after = await prisma.orderFinancialSnapshot.count({ where: { orderId: orderA } });
    // Значение то же — новая ревизия не нужна.
    expect(after).toBe(before);
    const expenses = await prisma.dailyFlowerExpense.count({ where: { financeProfileId: profileId, expenseDay: DAY } });
    expect(expenses).toBe(1);
  });

  it("Stage 3a не создаёт ни одного начисления", async () => {
    const entries = await prisma.ledgerEntry.count({ where: { floristId } });
    expect(entries).toBe(0);
  });
});

describe("права", () => {
  it("не-владелец не может применить исправление", async () => {
    for (const role of ["FLORIST", "CALL_CENTER"] as const) {
      await expect(
        fixDailyFlowerExpense({
          expenseDay: DAY,
          amountCents: 100,
          actor: { userId: OWNER.userId, role },
        })
      ).rejects.toThrow(FinanceFixError);
    }
  });

  it("страницы ассистента и настроек закрыты ролью владельца", () => {
    for (const file of [
      "src/app/dashboard/(owner)/finance/setup/page.tsx",
      "src/app/dashboard/(owner)/finance/settings/page.tsx",
      "src/app/dashboard/(owner)/finance/orders/[orderId]/page.tsx",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).toContain('requireRole("OWNER")');
    }
  });

  it("каждое server action проверяет роль само, а не полагается на layout", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/dashboard/(owner)/finance/setup/setupActions.ts"),
      "utf8"
    );
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(5);
    // Число проверок роли не меньше числа экспортированных действий.
    const guards = [...source.matchAll(/requireRole\("OWNER"\)/g)].length;
    expect(guards).toBeGreaterThanOrEqual(exported.length);
  });
});

describe("изоляция магазинов", () => {
  it("настройка одного магазина не применяется к другому", async () => {
    const other = await prisma.site.create({
      data: { name: `${RUN} other`, shortName: `${RUN.slice(0, 6)}O`.toUpperCase(), platform: "SHOPIFY" },
      select: { id: true },
    });
    const model = await prisma.siteAcquiringFeeModel.findFirst({ where: { siteId: other.id } });
    expect(model).toBeNull();
    await prisma.site.delete({ where: { id: other.id } });
  });
});
