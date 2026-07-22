import "server-only";
/**
 * Запись одного WooCommerce-товара в БД (для webhook product.created/updated). Upsert по
 * siteId+externalId и productId+externalId. Локальные поля Floremart НЕ перезаписываем:
 * floristPrice, defaultFloristComposition, floristComposition — не входят в update.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { NormalizedProduct } from "@/integrations/types";

function priceRange(variants: NormalizedProduct["variants"]): { min: Prisma.Decimal | null; max: Prisma.Decimal | null } {
  const pool = variants.filter((v) => v.available);
  const src = pool.length ? pool : variants;
  if (!src.length) return { min: null, max: null };
  let min = src[0].listPrice;
  let max = src[0].listPrice;
  for (const v of src) {
    if (v.listPrice < min) min = v.listPrice;
    if (v.listPrice > max) max = v.listPrice;
  }
  return { min: new Prisma.Decimal(min), max: new Prisma.Decimal(max) };
}

/** Upsert товара + вариантов из нормализованной формы. Возвращает productId. */
export async function upsertWooProduct(siteId: string, np: NormalizedProduct): Promise<string> {
  const { min, max } = priceRange(np.variants);
  const common = {
    name: np.name,
    image: np.image,
    status: np.status,
    productType: np.productType,
    adminUrl: np.adminUrl,
    minPrice: min,
    maxPrice: max,
    remoteDeleted: false,
    deletedAt: null,
    lastSyncedAt: new Date(),
  };
  const product = await prisma.product.upsert({
    where: { siteId_externalId: { siteId, externalId: np.externalId } },
    update: common, // floristPrice/defaultFloristComposition не трогаем
    create: { siteId, externalId: np.externalId, ...common },
    select: { id: true },
  });

  const seen = new Set<string>();
  for (const v of np.variants) {
    seen.add(v.externalId);
    const vCommon = {
      title: v.title,
      sku: v.sku,
      listPrice: new Prisma.Decimal(v.listPrice),
      compareAtPrice: v.compareAtPrice != null ? new Prisma.Decimal(v.compareAtPrice) : null,
      image: v.image,
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
      inventoryQty: v.inventoryQty,
      available: v.available,
      position: v.position,
      adminUrl: v.adminUrl,
      remoteDeleted: false,
      deletedAt: null,
      lastSyncedAt: new Date(),
    };
    await prisma.productVariant.upsert({
      where: { productId_externalId: { productId: product.id, externalId: v.externalId } },
      update: vCommon, // floristPrice/floristComposition варианта не трогаем
      create: { productId: product.id, externalId: v.externalId, ...vCommon },
    });
  }
  // Вариации, пропавшие из этого товара, помечаем remoteDeleted (в пределах товара — безопасно).
  await prisma.productVariant.updateMany({
    where: { productId: product.id, remoteDeleted: false, externalId: { notIn: [...seen] } },
    data: { remoteDeleted: true, deletedAt: new Date() },
  });
  return product.id;
}

/** product.deleted → пометить товар и его варианты remoteDeleted (физически не удаляем). */
export async function markWooProductDeleted(siteId: string, externalId: string): Promise<void> {
  const now = new Date();
  await prisma.product.updateMany({ where: { siteId, externalId, remoteDeleted: false }, data: { remoteDeleted: true, deletedAt: now } });
  await prisma.productVariant.updateMany({
    where: { product: { siteId, externalId }, remoteDeleted: false },
    data: { remoteDeleted: true, deletedAt: now },
  });
}
