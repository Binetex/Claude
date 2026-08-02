/**
 * DB integration: заказы до даты запуска расчёта — исторические.
 *
 * Смысл проверки: система не должна требовать привести в порядок период, когда финансовые
 * настройки ещё не существовали. Старые заказы не блокируют работу и не попадают в очередь,
 * но остаются доступными для явного пересчёта.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/historicalScope.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { detectFinanceIssues, getIssueSummary, listOpenIssues } from "./issues";
import { buildDayPlan } from "./snapshot";
import { listBurqDeliveryCandidates } from "./fix";

const RUN = `hist${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const OLD_DAY = new Date("2026-07-10T00:00:00.000Z");
const NEW_DAY = new Date("2026-07-28T00:00:00.000Z");
const START = "2026-07-20";
const NOW = new Date("2026-07-29T12:00:00.000Z");

let siteId = "";
let floristId = "";
let productId = "";
let oldOrder = "";
let newOrder = "";

async function makeOrder(n: string, day: Date): Promise<string> {
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
      itemsTotal: "100.00",
      tax: "10.00",
      deliveryCustomerCost: "20.00",
      customerTotal: "130.00",
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: "100.00", productId }] },
    },
    select: { id: true },
  });
  await prisma.delivery.create({ data: { orderId: o.id, provider: "BURQ", finalCost: "11.00" } });
  return o.id;
}

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
    data: { name: "Primary", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const florist = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  floristId = florist.id;

  await setFinanceProfile({ floristId, model: "PRIMARY", effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER });

  oldOrder = await makeOrder("old", OLD_DAY);
  newOrder = await makeOrder("new", NEW_DAY);
});

beforeEach(() => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = START;
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" DISABLE TRIGGER USER`);
  await prisma.orderFinancialSnapshot.deleteMany({ where: { order: { siteId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } });
  await prisma.delivery.deleteMany({ where: { order: { siteId } } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: floristId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("исторический период", () => {
  it("детектор не находит проблем в заказах до даты запуска", async () => {
    await detectFinanceIssues(NOW);
    const open = await listOpenIssues();
    const days = open.filter((i) => i.scopeDate).map((i) => i.scopeDate!.toISOString().slice(0, 10));

    expect(days).toContain("2026-07-28");
    expect(days).not.toContain("2026-07-10");
    expect(open.some((i) => i.orderId === oldOrder)).toBe(false);
    expect(open.some((i) => i.orderId === newOrder)).toBe(true);
  });

  it("старый заказ не предлагается к массовому подтверждению доставки", async () => {
    const candidates = await listBurqDeliveryCandidates(NOW);
    const ids = candidates.map((c) => c.orderId);
    expect(ids).toContain(newOrder);
    expect(ids).not.toContain(oldOrder);
  });

  it("«готово к расчёту» считает только дни с даты запуска", async () => {
    const summary = await getIssueSummary(NOW);
    expect(summary.startDate?.toISOString().slice(0, 10)).toBe(START);
    // Исторический день не считается ни готовым, ни заблокированным — он вне периода.
    expect(summary.readyDays).toBeLessThanOrEqual(1);
  });

  it("исторический день по-прежнему можно посчитать явно", async () => {
    // Механика никуда не делась: она просто никого не заставляет.
    const plan = await buildDayPlan(
      (await prisma.floristFinanceProfile.findFirstOrThrow({ where: { floristId }, select: { id: true } })).id,
      OLD_DAY
    );
    expect(plan).not.toBeNull();
    expect(plan!.result.orders).toHaveLength(1);
  });

  it("сдвиг даты запуска вперёд закрывает проблемы как исторические, а не как исправленные", async () => {
    process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-29";
    await detectFinanceIssues(NOW);

    const closed = await prisma.financeIssue.findMany({
      where: { orderId: newOrder, status: "AUTO_RESOLVED" },
      select: { resolutionComment: true },
    });
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((c) => /историч/i.test(c.resolutionComment ?? ""))).toBe(true);
  });

  it("без даты запуска проверок нет вовсе и очередь пуста", async () => {
    delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
    const r = await detectFinanceIssues(NOW);
    expect(r.opened).toBe(0);

    const open = await listOpenIssues();
    expect(open).toHaveLength(0);

    const summary = await getIssueSummary(NOW);
    expect(summary.startDate).toBeNull();
    expect(summary.disabledReason).toMatch(/FINANCE_PRIMARY_SHARE_START_DATE/);
  });
});
