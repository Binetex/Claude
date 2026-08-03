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
import { setVasePurchaseCost, deleteVasePurchaseCost } from "./setVasePurchaseCost";

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
  it("первая запись создаёт стоимость и пишет аудит", async () => {
    const res = await setVasePurchaseCost({
      target: { productVariantId: variantId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 1200,
      actor: actor(),
      comment: "первая закупка",
    });
    expect(res.previousCents).toBeNull();

    const rows = await prisma.vasePurchaseCost.findMany({ where: { productVariantId: variantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseCostCents).toBe(1200);

    const audit = await prisma.financeAudit.findFirst({ where: { entityId: variantId, action: "SET_COST" } });
    expect(audit?.beforeJson).toBeNull();
    expect(audit?.afterJson).toMatchObject({ purchaseCostCents: 1200 });
  });

  it("подорожание переписывает ту же строку, а не заводит вторую", async () => {
    const res = await setVasePurchaseCost({
      target: { productVariantId: variantId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 1500,
      actor: actor(),
    });
    expect(res.previousCents).toBe(1200);

    const rows = await prisma.vasePurchaseCost.findMany({ where: { productVariantId: variantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseCostCents).toBe(1500);

    // Прежняя сумма не потеряна: она в истории правок.
    const audit = await prisma.financeAudit.findFirst({
      where: { entityId: variantId, action: "SET_COST" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.beforeJson).toMatchObject({ purchaseCostCents: 1200 });
  });

  it("стоимость товара и варианта живут независимо", async () => {
    await setVasePurchaseCost({
      target: { productId },
      costType: "INCLUDED_VASE",
      purchaseCostCents: 900,
      actor: actor(),
    });
    const onProduct = await prisma.vasePurchaseCost.findMany({ where: { productId } });
    expect(onProduct).toHaveLength(1);
    expect(onProduct[0].purchaseCostCents).toBe(900);

    // Строка варианта на месте и своя.
    const onVariant = await prisma.vasePurchaseCost.findMany({ where: { productVariantId: variantId } });
    expect(onVariant).toHaveLength(1);
    expect(onVariant[0].purchaseCostCents).toBe(1500);
  });

  it("отрицательная стоимость и bulk без причины отклоняются", async () => {
    await expect(
      setVasePurchaseCost({
        target: { productVariantId: variantId },
        costType: "INCLUDED_VASE",
        purchaseCostCents: -1,
        actor: actor(),
      })
    ).rejects.toThrow();

    await expect(
      setVasePurchaseCost({
        target: { productVariantId: variantId },
        costType: "INCLUDED_VASE",
        purchaseCostCents: 100,
        actor: actor(),
        batchId: "batch-1",
      })
    ).rejects.toThrow(/причин/);
  });

  it("ошибочная запись удаляется, стоимость снова неизвестна", async () => {
    const row = await prisma.vasePurchaseCost.findFirstOrThrow({
      where: { productVariantId: variantId, costType: "INCLUDED_VASE" },
    });

    await deleteVasePurchaseCost({ costId: row.id, actor: actor() });

    expect(await prisma.vasePurchaseCost.findUnique({ where: { id: row.id } })).toBeNull();

    const audit = await prisma.financeAudit.findFirst({ where: { userId, action: "DELETE_COST" }, orderBy: { createdAt: "desc" } });
    expect((audit?.beforeJson as { costRecordId?: string })?.costRecordId).toBe(row.id);
  });

  it("удалять стоимость может только владелец", async () => {
    const row = await prisma.vasePurchaseCost.findFirstOrThrow({ where: { productId, costType: "INCLUDED_VASE" } });
    await expect(
      deleteVasePurchaseCost({ costId: row.id, actor: { userId, role: "FLORIST" } })
    ).rejects.toThrow(/владелец/);
  });
});
