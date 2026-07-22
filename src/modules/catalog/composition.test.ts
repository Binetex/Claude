import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

/**
 * Интеграционные тесты локальных составов вариантов и снимков состава в заказах.
 * Работают на реальной БД (DATABASE_URL), создают изолированные фикстуры с уникальным
 * суффиксом и полностью удаляют их после себя. Демо-данные не затрагиваются.
 *
 * ВАЖНО: не запускать против production-БД. Для CI/dev использовать отдельную тестовую БД.
 */
const suffix = `comp-${Date.now()}`;
let siteId: string;
let productId: string;
let vSmall: string;
let vMedium: string;
let vLarge: string;

// Набор полей, которыми Shopify sync обновляет вариант (см. modules/catalog/sync.ts upsertProduct):
// floristComposition СЮДА НЕ входит — это и проверяем.
const syncUpdateFields = {
  title: "Small",
  sku: "SKU-NEW",
  listPrice: new Prisma.Decimal(150),
  available: false,
  lastSyncedAt: new Date(),
  remoteDeleted: false,
  deletedAt: null,
} satisfies Prisma.ProductVariantUpdateInput;

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `T ${suffix}`, shortName: `T${suffix}`.slice(0, 12), platform: "SHOPIFY" },
  });
  siteId = site.id;

  const product = await prisma.product.create({
    data: {
      name: "White Roses Bouquet",
      siteId,
      externalId: `P-${suffix}`,
      defaultFloristComposition: "template roses",
      variants: {
        create: [
          { externalId: `V-S-${suffix}`, title: "Small", listPrice: new Prisma.Decimal(100) },
          { externalId: `V-M-${suffix}`, title: "Medium", listPrice: new Prisma.Decimal(150) },
          { externalId: `V-L-${suffix}`, title: "Large", listPrice: new Prisma.Decimal(200) },
        ],
      },
    },
    include: { variants: { orderBy: { title: "asc" } } },
  });
  productId = product.id;
  vLarge = product.variants.find((v) => v.title === "Large")!.id;
  vMedium = product.variants.find((v) => v.title === "Medium")!.id;
  vSmall = product.variants.find((v) => v.title === "Small")!.id;
});

afterAll(async () => {
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.productVariant.deleteMany({ where: { product: { siteId } } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.site.delete({ where: { id: siteId } });
  await prisma.$disconnect();
});

describe("составы вариантов", () => {
  it("14.1/14.2 у каждого варианта свой состав; Small не влияет на Medium/Large", async () => {
    await prisma.productVariant.update({ where: { id: vSmall }, data: { floristComposition: "12 white roses" } });
    await prisma.productVariant.update({ where: { id: vMedium }, data: { floristComposition: "24 white roses" } });
    await prisma.productVariant.update({ where: { id: vLarge }, data: { floristComposition: "36 white roses" } });

    const [s, m, l] = await Promise.all([
      prisma.productVariant.findUniqueOrThrow({ where: { id: vSmall } }),
      prisma.productVariant.findUniqueOrThrow({ where: { id: vMedium } }),
      prisma.productVariant.findUniqueOrThrow({ where: { id: vLarge } }),
    ]);
    expect(s.floristComposition).toBe("12 white roses");
    expect(m.floristComposition).toBe("24 white roses");
    expect(l.floristComposition).toBe("36 white roses");
  });

  it("14.3 sync-обновление (без floristComposition) не перезаписывает состав", async () => {
    await prisma.productVariant.update({ where: { id: vSmall }, data: { floristComposition: "12 white roses" } });
    // Имитируем то, что делает sync: обновляет внешние поля, но НЕ floristComposition.
    await prisma.productVariant.update({ where: { id: vSmall }, data: syncUpdateFields });
    const s = await prisma.productVariant.findUniqueOrThrow({ where: { id: vSmall } });
    expect(s.floristComposition).toBe("12 white roses");
    expect(s.sku).toBe("SKU-NEW"); // внешние поля обновились
  });

  it("14.4 remoteDeleted-вариант сохраняет состав", async () => {
    await prisma.productVariant.update({ where: { id: vLarge }, data: { floristComposition: "36 white roses" } });
    await prisma.productVariant.updateMany({ where: { id: vLarge }, data: { remoteDeleted: true, deletedAt: new Date() } });
    const l = await prisma.productVariant.findUniqueOrThrow({ where: { id: vLarge } });
    expect(l.remoteDeleted).toBe(true);
    expect(l.floristComposition).toBe("36 white roses");
  });

  it("14.5 повторный upsert по тому же externalId сохраняет состав", async () => {
    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: vMedium } });
    await prisma.productVariant.upsert({
      where: { productId_externalId: { productId, externalId: before.externalId } },
      update: syncUpdateFields, // как при повторной синхронизации — без floristComposition
      create: { productId, externalId: before.externalId, title: "Medium", listPrice: new Prisma.Decimal(150) },
    });
    const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: vMedium } });
    expect(after.floristComposition).toBe("24 white roses");
  });

  it("14.6 новый variant ID не получает состав старого", async () => {
    const created = await prisma.productVariant.create({
      data: { productId, externalId: `V-NEW-${suffix}`, title: "Extra", listPrice: new Prisma.Decimal(250) },
    });
    expect(created.floristComposition).toBeNull();
  });
});

describe("snapshot состава в заказе", () => {
  it("14.7/14.8 snapshot не меняется при изменении состава варианта", async () => {
    const order = await prisma.order.create({
      data: {
        orderNumber: `#SNAP-${suffix}`,
        siteId,
        platform: "SHOPIFY",
        source: "Shopify",
        externalCreatedAt: new Date(),
        deliveryDate: new Date(),
        deliveryWindow: "",
        recipientName: "T",
        recipientPhone: "",
        addressLine: "T",
        city: "T",
        zip: "0",
        senderName: "T",
        senderPhone: "",
        itemsTotal: new Prisma.Decimal(0),
        customerTotal: new Prisma.Decimal(0),
        items: {
          create: [
            { name: "White Roses Bouquet", variantId: vMedium, variantName: "Medium", quantity: 2, externalPrice: new Prisma.Decimal(150), floristCompositionSnapshot: "24 white roses" },
          ],
        },
      },
      include: { items: true },
    });
    const itemId = order.items[0].id;

    // Меняем состав варианта — snapshot заказа не должен измениться.
    await prisma.productVariant.update({ where: { id: vMedium }, data: { floristComposition: "999 changed roses" } });
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.floristCompositionSnapshot).toBe("24 white roses");
  });
});
