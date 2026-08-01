/**
 * DB integration: смена закупочной стоимости вазы на ЖИВОЙ локальной БД. Проверяет то, чего
 * не покажут моки: реальный exclusion-constraint, повтор при гонке и запись FinanceAudit.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/catalog/finance/setVasePurchaseCost.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setVasePurchaseCost } from "./setVasePurchaseCost";

const RUN = `vase${crypto.randomBytes(3).toString("hex")}`;
let siteId = "";
let productId = "";
let variantId = "";
let userId = "";

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  userId = user.id;

  const site = await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  });
  siteId = site.id;

  const product = await prisma.product.create({
    data: { name: `${RUN} Apricot & Vase`, siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT", defaultIncludesVase: true },
    select: { id: true },
  });
  productId = product.id;

  const variant = await prisma.productVariant.create({
    data: { productId, externalId: `${RUN}-v`, title: "Clear Glass Vase 8 in", listPrice: "185.00", includesVase: true },
    select: { id: true },
  });
  variantId = variant.id;
});

afterAll(async () => {
  await prisma.financeAudit.deleteMany({ where: { userId } });
  await prisma.vasePurchaseCost.deleteMany({ where: { OR: [{ productId }, { productVariantId: variantId }] } });
  await prisma.productVariant.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

const actor = () => ({ userId, role: "OWNER" as const });

describe("setVasePurchaseCost", () => {
  it("первая запись открывает интервал и пишет аудит", async () => {
    const res = await setVasePurchaseCost({
      target: { productVariantId: variantId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 1200,
      effectiveFrom: new Date("2026-08-01T00:00:00Z"),
      actor: actor(),
      comment: "первая закупка",
    });
    expect(res.closedId).toBeNull();

    const rows = await prisma.vasePurchaseCost.findMany({ where: { productVariantId: variantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseCostCents).toBe(1200);
    expect(rows[0].effectiveTo).toBeNull();

    const audit = await prisma.financeAudit.findFirst({ where: { entityId: variantId, action: "SET_COST" } });
    expect(audit?.beforeJson).toBeNull();
    expect(audit?.afterJson).toMatchObject({ purchaseCostCents: 1200 });
  });

  it("подорожание закрывает прошлый интервал и открывает новый", async () => {
    const res = await setVasePurchaseCost({
      target: { productVariantId: variantId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 1500,
      effectiveFrom: new Date("2026-11-01T00:00:00Z"),
      actor: actor(),
    });
    expect(res.closedId).not.toBeNull();

    const rows = await prisma.vasePurchaseCost.findMany({
      where: { productVariantId: variantId },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].effectiveTo?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(rows[1].effectiveTo).toBeNull();
    // История не переписана: старая цена на месте.
    expect(rows[0].purchaseCostCents).toBe(1200);
  });

  it("параллельные вызовы оставляют ровно один открытый интервал", async () => {
    const at = new Date("2027-01-01T00:00:00Z");
    const results = await Promise.allSettled([
      setVasePurchaseCost({ target: { productVariantId: variantId }, costType: "INCLUDED_VASE", purchaseCostCents: 1700, effectiveFrom: at, actor: actor() }),
      setVasePurchaseCost({ target: { productVariantId: variantId }, costType: "INCLUDED_VASE", purchaseCostCents: 1800, effectiveFrom: at, actor: actor() }),
    ]);
    // Один из двух мог законно провалиться (одинаковая дата начала), но состояние обязано остаться целым.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const open = await prisma.vasePurchaseCost.findMany({
      where: { productVariantId: variantId, costType: "INCLUDED_VASE", effectiveTo: null },
    });
    expect(open).toHaveLength(1);
  });

  it("стоимость товара и варианта живут независимо", async () => {
    await setVasePurchaseCost({
      target: { productId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 900,
      effectiveFrom: new Date("2026-08-01T00:00:00Z"),
      actor: actor(),
    });
    const onProduct = await prisma.vasePurchaseCost.findMany({ where: { productId, effectiveTo: null } });
    expect(onProduct).toHaveLength(1);
    expect(onProduct[0].purchaseCostCents).toBe(900);
  });

  it("отрицательная стоимость и bulk без причины отклоняются", async () => {
    await expect(
      setVasePurchaseCost({
        target: { productVariantId: variantId },
        costType: "INCLUDED_VASE",
        purchaseCostCents: -1,
        effectiveFrom: new Date("2027-06-01T00:00:00Z"),
        actor: actor(),
      })
    ).rejects.toThrow();

    await expect(
      setVasePurchaseCost({
        target: { productVariantId: variantId },
        costType: "INCLUDED_VASE",
        purchaseCostCents: 100,
        effectiveFrom: new Date("2027-06-01T00:00:00Z"),
        actor: actor(),
        batchId: "batch-1",
      })
    ).rejects.toThrow(/причин/);
  });

  it("нельзя открыть интервал раньше действующего", async () => {
    await expect(
      setVasePurchaseCost({
        target: { productVariantId: variantId },
        costType: "INCLUDED_VASE",
        purchaseCostCents: 100,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        actor: actor(),
      })
    ).rejects.toThrow(/позже/);
  });
});
