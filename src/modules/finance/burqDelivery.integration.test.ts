/**
 * DB integration: массовое подтверждение доставки по суммам Burq.
 *
 * Главное, что здесь закреплено: инструмент НЕ трогает заказы без суммы Burq, каждому
 * подтверждённому заказу пишет СВОЮ сумму и СВОЮ строку аудита, и никаких начислений
 * не создаёт.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/burqDelivery.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { FinanceFixError, confirmBurqDeliveryCosts, listBurqDeliveryCandidates, previewBurqDeliveryConfirmation } from "./fix";

const RUN = `burq${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");

let siteId = "";
let floristId = "";
let productId = "";
let withFinal = "";
let withQuote = "";
let withoutBurq = "";
let alreadyConfirmed = "";

async function makeOrder(n: string, opts: { finalCost?: string; quote?: string; confirmed?: boolean }): Promise<string> {
  const order = await prisma.order.create({
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
      itemsTotal: "100.00",
      tax: "10.00",
      deliveryCustomerCost: "20.00",
      customerTotal: "130.00",
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      ...(opts.confirmed ? { deliveryActualCost: "7.00", deliveryActualCostConfirmedAt: new Date() } : {}),
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: "100.00", productId }] },
    },
    select: { id: true },
  });

  if (opts.finalCost || opts.quote) {
    await prisma.delivery.create({
      data: {
        orderId: order.id,
        provider: "BURQ",
        ...(opts.finalCost ? { finalCost: opts.finalCost } : {}),
        ...(opts.quote ? { quoteAmount: opts.quote } : {}),
      },
    });
  }
  return order.id;
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
    data: { name: "Primary", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const florist = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  floristId = florist.id;

  await setFinanceProfile({ floristId, model: "PRIMARY", effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER });

  withFinal = await makeOrder("final", { finalCost: "12.50" });
  withQuote = await makeOrder("quote", { quote: "9.99" });
  withoutBurq = await makeOrder("none", {});
  alreadyConfirmed = await makeOrder("done", { finalCost: "8.00", confirmed: true });
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

describe("список кандидатов", () => {
  it("включает только заказы с суммой Burq и без подтверждения", async () => {
    const candidates = await listBurqDeliveryCandidates(new Date("2026-07-29T12:00:00.000Z"));
    const ids = candidates.map((c) => c.orderId);

    expect(ids).toContain(withFinal);
    expect(ids).toContain(withQuote);
    // Заказ без суммы Burq подставлять нечем — его в списке быть не должно.
    expect(ids).not.toContain(withoutBurq);
    // Уже подтверждённый заказ повторно не предлагается.
    expect(ids).not.toContain(alreadyConfirmed);
  });

  it("различает фактическую стоимость и котировку", async () => {
    const candidates = await listBurqDeliveryCandidates(new Date("2026-07-29T12:00:00.000Z"));
    expect(candidates.find((c) => c.orderId === withFinal)).toMatchObject({ burqSource: "FINAL", burqCents: 1250 });
    expect(candidates.find((c) => c.orderId === withQuote)).toMatchObject({ burqSource: "QUOTE", burqCents: 999 });
  });
});

describe("предпросмотр", () => {
  it("считает выбранное и ничего не пишет", async () => {
    const before = await prisma.order.findUnique({ where: { id: withFinal }, select: { deliveryActualCostConfirmedAt: true } });

    const preview = await previewBurqDeliveryConfirmation([withFinal, withQuote]);
    expect(preview.orders).toBe(2);
    expect(preview.totalCents).toBe(1250 + 999);
    expect(preview.finalCount).toBe(1);
    expect(preview.quoteCount).toBe(1);

    const after = await prisma.order.findUnique({ where: { id: withFinal }, select: { deliveryActualCostConfirmedAt: true } });
    expect(after?.deliveryActualCostConfirmedAt).toEqual(before?.deliveryActualCostConfirmedAt);
  });
});

describe("применение", () => {
  it("каждому заказу пишет свою сумму и свою строку аудита", async () => {
    const r = await confirmBurqDeliveryCosts({
      orderIds: [withFinal, withQuote],
      actor: OWNER,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });
    expect(r.confirmed).toBe(2);

    const a = await prisma.order.findUnique({ where: { id: withFinal } });
    const b = await prisma.order.findUnique({ where: { id: withQuote } });
    expect(Number(a!.deliveryActualCost)).toBe(12.5);
    expect(Number(b!.deliveryActualCost)).toBe(9.99);
    expect(a!.deliveryActualCostConfirmedAt).not.toBeNull();
    expect(b!.deliveryActualCostConfirmedAt).not.toBeNull();

    const audits = await prisma.financeAudit.findMany({
      where: { entity: "Order", action: "SET_DELIVERY_ACTUAL_COST", entityId: { in: [withFinal, withQuote] } },
    });
    expect(audits).toHaveLength(2);
    // Одна операция — один batchId, но строк столько же, сколько заказов.
    expect(new Set(audits.map((x) => x.batchId)).size).toBe(1);
    expect(audits.every((x) => x.batchId != null)).toBe(true);
  });

  it("не трогает заказ без суммы Burq даже если он передан явно", async () => {
    const before = await prisma.order.findUnique({ where: { id: withoutBurq } });
    await expect(
      confirmBurqDeliveryCosts({ orderIds: [withoutBurq], actor: OWNER, now: new Date("2026-07-29T12:00:00.000Z") })
    ).rejects.toThrow(FinanceFixError);
    const after = await prisma.order.findUnique({ where: { id: withoutBurq } });
    expect(after!.deliveryActualCostConfirmedAt).toBe(before!.deliveryActualCostConfirmedAt);
    expect(Number(after!.deliveryActualCost)).toBe(0);
  });

  it("закрывает связанные проблемы и публикует ревизии снимков", async () => {
    const snapshots = await prisma.orderFinancialSnapshot.count({ where: { orderId: withFinal } });
    expect(snapshots).toBeGreaterThan(0);

    const stillOpen = await prisma.financeIssue.count({
      where: { status: "OPEN", type: "DELIVERY_ACTUAL_COST_MISSING", orderId: { in: [withFinal, withQuote] } },
    });
    expect(stillOpen).toBe(0);
  });

  it("не создаёт начислений", async () => {
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(0);
  });

  it("доступно только владельцу", async () => {
    await expect(
      confirmBurqDeliveryCosts({ orderIds: [withFinal], actor: { userId: OWNER.userId, role: "CALL_CENTER" } })
    ).rejects.toThrow(/только владельцу/i);
  });

  it("пустой выбор отклоняется", async () => {
    await expect(confirmBurqDeliveryCosts({ orderIds: [], actor: OWNER })).rejects.toThrow(FinanceFixError);
  });
});
