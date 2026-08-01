/**
 * DB integration: привязка вазы к букету на ЖИВОЙ локальной БД. Проверяет то, чего не покажут
 * моки: реальные проверки принадлежности магазину и эффективного типа, атомарность состояний,
 * запись FinanceAudit и то, что синхронизация каталога связь не сбрасывает.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/catalog/finance/vaseLink.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setVariantVase, setProductDefaultVase, listVaseOptions } from "./vaseLink";

const RUN = `vl${crypto.randomBytes(3).toString("hex")}`;
let userId = "";
let siteA = "";
let siteB = "";
let bouquetProduct = "";
let bouquetV1 = "";
let bouquetV2 = "";
let vaseVariantA = "";
let vaseVariantArchived = "";
let vaseVariantB = ""; // другой магазин
let giftVariant = "";

async function makeProduct(siteId: string, name: string, financialType: "FLOWER_PRODUCT" | "VASE" | "GIFT" | null) {
  return prisma.product.create({
    data: { name: `${RUN} ${name}`, siteId, externalId: `${RUN}-${name}`, financialType },
    select: { id: true },
  });
}
async function makeVariant(productId: string, title: string, extra: Record<string, unknown> = {}) {
  return prisma.productVariant.create({
    data: { productId, externalId: `${RUN}-${title}`, title, listPrice: "100.00", ...extra },
    select: { id: true },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  userId = user.id;

  const a = await prisma.site.create({ data: { name: `${RUN} A`, shortName: `${RUN}A`.slice(0, 10), platform: "SHOPIFY" }, select: { id: true } });
  const b = await prisma.site.create({ data: { name: `${RUN} B`, shortName: `${RUN}B`.slice(0, 10), platform: "SHOPIFY" }, select: { id: true } });
  siteA = a.id;
  siteB = b.id;

  const bp = await makeProduct(siteA, "Bouquet", "FLOWER_PRODUCT");
  bouquetProduct = bp.id;
  bouquetV1 = (await makeVariant(bouquetProduct, "V1")).id;
  bouquetV2 = (await makeVariant(bouquetProduct, "V2")).id;

  // Ваза: тип задан на ТОВАРЕ, у варианта null — проверяем резолв эффективного типа.
  const vp = await makeProduct(siteA, "Vase", "VASE");
  vaseVariantA = (await makeVariant(vp.id, "Clear Glass 8in")).id;
  vaseVariantArchived = (await makeVariant(vp.id, "Archived Vase", { remoteDeleted: true })).id;

  const vpB = await makeProduct(siteB, "VaseOtherSite", "VASE");
  vaseVariantB = (await makeVariant(vpB.id, "Foreign Vase")).id;

  const gp = await makeProduct(siteA, "Gift", "GIFT");
  giftVariant = (await makeVariant(gp.id, "Chocolate")).id;
});

afterAll(async () => {
  await prisma.financeAudit.deleteMany({ where: { userId } });
  await prisma.productVariant.updateMany({ where: { product: { siteId: { in: [siteA, siteB] } } }, data: { includedVaseVariantId: null } });
  await prisma.product.updateMany({ where: { siteId: { in: [siteA, siteB] } }, data: { defaultIncludedVaseVariantId: null } });
  // Стоимость бывает и на варианте, и на товаре: чистим оба уровня, иначе Restrict не даст
  // удалить товар — что и правильно, финансовая история просто так не исчезает.
  await prisma.vasePurchaseCost.deleteMany({
    where: {
      OR: [
        { variant: { product: { siteId: { in: [siteA, siteB] } } } },
        { product: { siteId: { in: [siteA, siteB] } } },
      ],
    },
  });
  await prisma.productVariant.deleteMany({ where: { product: { siteId: { in: [siteA, siteB] } } } });
  await prisma.product.deleteMany({ where: { siteId: { in: [siteA, siteB] } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

const actor = () => ({ userId, role: "OWNER" as const });

describe("привязка вазы", () => {
  it("товар задаёт вазу по умолчанию, состояние согласовано", async () => {
    await setProductDefaultVase({
      productId: bouquetProduct,
      selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantA },
      actor: actor(),
    });
    const p = await prisma.product.findUniqueOrThrow({ where: { id: bouquetProduct } });
    expect(p.defaultIncludesVase).toBe(true);
    expect(p.defaultIncludedVaseVariantId).toBe(vaseVariantA);
  });

  it("вариант переопределяет вазу", async () => {
    await setVariantVase({ variantId: bouquetV1, selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantA }, actor: actor() });
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: bouquetV1 } });
    expect(v.includesVase).toBe(true);
    expect(v.includedVaseVariantId).toBe(vaseVariantA);
  });

  it("«без вазы» очищает ссылку и не оставляет противоречия", async () => {
    await setVariantVase({ variantId: bouquetV1, selection: { mode: "NO_VASE" }, actor: actor() });
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: bouquetV1 } });
    expect(v.includesVase).toBe(false);
    expect(v.includedVaseVariantId).toBeNull();
  });

  it("«наследовать» обнуляет оба поля", async () => {
    await setVariantVase({ variantId: bouquetV1, selection: { mode: "INHERIT" }, actor: actor() });
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: bouquetV1 } });
    expect(v.includesVase).toBeNull();
    expect(v.includedVaseVariantId).toBeNull();
  });
});

describe("запреты", () => {
  it("нельзя привязать вазу другого магазина", async () => {
    await expect(
      setVariantVase({ variantId: bouquetV2, selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantB }, actor: actor() })
    ).rejects.toThrow(/магазин/);
  });

  it("нельзя привязать позицию, которая не ваза", async () => {
    await expect(
      setVariantVase({ variantId: bouquetV2, selection: { mode: "LINKED_VASE", vaseVariantId: giftVariant }, actor: actor() })
    ).rejects.toThrow(/Ваза/i);
  });

  it("нельзя привязать архивную вазу", async () => {
    await expect(
      setVariantVase({ variantId: bouquetV2, selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantArchived }, actor: actor() })
    ).rejects.toThrow(/архивн/);
  });

  it("нельзя привязать вариант к самому себе", async () => {
    await expect(
      setVariantVase({ variantId: bouquetV2, selection: { mode: "LINKED_VASE", vaseVariantId: bouquetV2 }, actor: actor() })
    ).rejects.toThrow(/самому себе/);
  });

  it("не владелец получает отказ", async () => {
    await expect(
      setVariantVase({
        variantId: bouquetV2,
        selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantA },
        actor: { userId, role: "FLORIST" },
      })
    ).rejects.toThrow(/владелец/);
  });
});

describe("селектор ваз", () => {
  it("отдаёт только активные вазы своего магазина, тип может быть унаследован от товара", async () => {
    const options = await listVaseOptions(siteA);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(vaseVariantA);
    expect(ids).not.toContain(vaseVariantArchived);
    expect(ids).not.toContain(vaseVariantB);
    expect(ids).not.toContain(giftVariant);
  });

  it("показывает стоимость, заданную на карточке ТОВАРА, а не только у варианта", async () => {
    const vp = await prisma.productVariant.findUniqueOrThrow({
      where: { id: vaseVariantA },
      select: { productId: true },
    });
    await prisma.vasePurchaseCost.create({
      data: {
        productId: vp.productId,
        costType: "STANDALONE_VASE",
        purchaseCostCents: 900,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        createdBy: userId,
      },
    });
    const option = (await listVaseOptions(siteA)).find((o) => o.id === vaseVariantA);
    expect(option?.costCents).toBe(900);
  });

  it("черновик магазина остаётся вазой и помечается", async () => {
    const vp = await prisma.productVariant.findUniqueOrThrow({ where: { id: vaseVariantA }, select: { productId: true } });
    await prisma.product.update({ where: { id: vp.productId }, data: { status: "DRAFT" } });
    const option = (await listVaseOptions(siteA)).find((o) => o.id === vaseVariantA);
    expect(option).toBeDefined();
    expect(option?.isDraft).toBe(true);
    await prisma.product.update({ where: { id: vp.productId }, data: { status: "ACTIVE" } });
  });
});

describe("аудит и синхронизация", () => {
  it("каждое изменение пишет FinanceAudit со снимком названия", async () => {
    const rows = await prisma.financeAudit.findMany({ where: { userId, action: "SET_INCLUDED_VASE" }, orderBy: { createdAt: "asc" } });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0].entityNameSnapshot).toContain(RUN);
    expect(rows.some((r) => (r.afterJson as { mode?: string })?.mode === "NO_VASE")).toBe(true);
  });

  it("upsert синхронизации не сбрасывает связь и классификацию", async () => {
    await setVariantVase({ variantId: bouquetV2, selection: { mode: "LINKED_VASE", vaseVariantId: vaseVariantA }, actor: actor() });
    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: bouquetV2 } });

    // Ровно те поля, которые пишет catalog/sync: цены и снимки платформы, без финансовых полей.
    await prisma.productVariant.update({
      where: { id: bouquetV2 },
      data: { title: "V2 renamed", listPrice: "222.00", available: false, lastSyncedAt: new Date() },
    });

    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: bouquetV2 } });
    expect(after.includedVaseVariantId).toBe(before.includedVaseVariantId);
    expect(after.includesVase).toBe(before.includesVase);
    expect(after.financialType).toBe(before.financialType);
  });
});
