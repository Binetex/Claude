/**
 * DB integration: поиск закупочной стоимости вазы для букета «с вазой».
 *
 * Стоимость вазы можно задать двумя способами — на конкретном ВАРИАНТЕ и на КАРТОЧКЕ
 * ТОВАРА. Резолв Stage 1 умеет оба, но сборщик снимка должен принести ему обе выборки.
 * Пропущенный товар связанной вазы приводил к тому, что заказ молча выпадал из расчёта
 * с причиной «стоимость неизвестна», хотя она была задана — этот тест закрывает случай.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/vaseCostLookup.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { buildDayPlan } from "./snapshot";

const RUN = `vcl${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-08-01T00:00:00.000Z");

let siteId = "";
let floristId = "";
let profileId = "";
let orderOnProduct = "";
let orderOnVariant = "";

/** Букет «с вазой», связанный с вариантом-вазой. */
async function makeBouquetWithVase(n: string, vaseVariantId: string): Promise<{ orderId: string }> {
  const product = await prisma.product.create({
    data: { name: `${RUN} bouquet ${n}`, siteId, externalId: `${RUN}-bp-${n}`, financialType: "FLOWER_PRODUCT" },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      externalId: `${RUN}-bv-${n}`,
      title: "Large + vase",
      listPrice: "200.00",
      includesVase: true,
      includedVaseVariantId: vaseVariantId,
    },
    select: { id: true },
  });

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
      itemsTotal: "200.00",
      tax: "10.00",
      deliveryCustomerCost: "20.00",
      customerTotal: "230.00",
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      deliveryActualCost: "10.00",
      deliveryActualCostConfirmedAt: new Date(),
      items: {
        create: [
          { name: `Bouquet ${n}`, quantity: 1, externalPrice: "200.00", productId: product.id, variantId: variant.id },
        ],
      },
    },
    select: { id: true },
  });
  return { orderId: order.id };
}

/** Ваза-товар с вариантом. Стоимость задаётся снаружи — в этом весь смысл теста. */
async function makeVase(n: string): Promise<{ productId: string; variantId: string }> {
  const product = await prisma.product.create({
    data: { name: `${RUN} vase ${n}`, siteId, externalId: `${RUN}-vp-${n}`, financialType: "VASE" },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, externalId: `${RUN}-vv-${n}`, title: "Default Title", listPrice: "25.00" },
    select: { id: true },
  });
  return { productId: product.id, variantId: variant.id };
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-08-01";

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

  const user = await prisma.user.create({
    data: { name: "Primary", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const florist = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  floristId = florist.id;

  const { createdId } = await setFinanceProfile({
    floristId,
    model: "PRIMARY",
    sharePercentBp: 6660,
    effectiveFrom: DAY,
    actor: OWNER,
  });
  profileId = createdId;

  // Ваза A: стоимость задана на КАРТОЧКЕ ТОВАРА — именно этот случай ломался.
  const vaseA = await makeVase("A");
  await prisma.vasePurchaseCost.create({
    data: {
      productId: vaseA.productId,
      costType: "STANDALONE_VASE",
      purchaseCostCents: 2000,
      effectiveFrom: DAY,
      createdBy: OWNER.userId,
    },
  });
  orderOnProduct = (await makeBouquetWithVase("prod", vaseA.variantId)).orderId;

  // Ваза B: стоимость задана на ВАРИАНТЕ — этот путь работал и раньше.
  const vaseB = await makeVase("B");
  await prisma.vasePurchaseCost.create({
    data: {
      productVariantId: vaseB.variantId,
      costType: "STANDALONE_VASE",
      purchaseCostCents: 3000,
      effectiveFrom: DAY,
      createdBy: OWNER.userId,
    },
  });
  orderOnVariant = (await makeBouquetWithVase("var", vaseB.variantId)).orderId;
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" DISABLE TRIGGER USER`);
  await prisma.orderFinancialSnapshot.deleteMany({ where: { order: { siteId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.vasePurchaseCost.deleteMany({ where: { OR: [{ product: { siteId } }, { variant: { product: { siteId } } }] } });
  await prisma.productVariant.deleteMany({ where: { product: { siteId } } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: floristId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("закупочная стоимость связанной вазы", () => {
  it("находится, когда задана на КАРТОЧКЕ ТОВАРА вазы", async () => {
    const plan = await buildDayPlan(profileId, DAY);
    const computed = plan!.result.orders.find((o) => o.orderId === orderOnProduct)!;

    expect(computed.missing).not.toContain("VASE_GIFT_COST");
    expect(computed.vaseGiftCostCents).toBe(2000);
  });

  it("находится, когда задана на ВАРИАНТЕ вазы", async () => {
    const plan = await buildDayPlan(profileId, DAY);
    const computed = plan!.result.orders.find((o) => o.orderId === orderOnVariant)!;

    expect(computed.missing).not.toContain("VASE_GIFT_COST");
    expect(computed.vaseGiftCostCents).toBe(3000);
  });

  it("оба заказа попадают в расчёт, а не выпадают молча", async () => {
    const plan = await buildDayPlan(profileId, DAY);
    const withVaseIssue = plan!.result.orders.filter((o) => o.missing.includes("VASE_GIFT_COST"));
    expect(withVaseIssue).toHaveLength(0);
  });
});
