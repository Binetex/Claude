import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getCatalogAdapter } from "@/integrations/catalog";
import { resolveShopifyAccessToken } from "@/integrations/shopify/customApp/credentials";
import type { NormalizedProduct, NormalizedVariant } from "@/integrations/types";
import type { CatalogSite } from "@/integrations/types";

export type ProductSyncResult = {
  started: boolean; // false — если синхронизация уже шла и мы не запускали вторую
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  total: number | null;
};

// Если строка RUNNING «висит» дольше этого времени — считаем её брошенной и перезапускаем.
const STALE_RUNNING_MS = 15 * 60 * 1000;
const PROGRESS_EVERY = 10; // как часто писать прогресс в SiteSync

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

/** min/max цены сайта по доступным неудалённым вариантам (fallback — по всем присутствующим). */
function priceRange(variants: NormalizedVariant[]): { min: Prisma.Decimal | null; max: Prisma.Decimal | null } {
  const pool = variants.filter((v) => v.available);
  const src = pool.length ? pool : variants;
  if (!src.length) return { min: null, max: null };
  let min = src[0].listPrice;
  let max = src[0].listPrice;
  for (const v of src) {
    if (v.listPrice < min) min = v.listPrice;
    if (v.listPrice > max) max = v.listPrice;
  }
  return { min: dec(min), max: dec(max) };
}

/** Upsert одного товара со всеми вариантами. floristPrice НИКОГДА не перезаписывается. */
async function upsertProduct(
  siteId: string,
  np: NormalizedProduct,
  now: Date,
  runId: string
): Promise<{ created: boolean; seenVariantExternalIds: Set<string> }> {
  const { min, max } = priceRange(np.variants);

  const common = {
    name: np.name,
    image: np.image,
    status: np.status,
    productType: np.productType,
    adminUrl: np.adminUrl,
    onlineUrl: np.onlineUrl,
    minPrice: min,
    maxPrice: max,
    lastSyncedAt: now,
    lastSeenSyncRunId: runId, // помечаем «виден в этом прогоне»
    remoteDeleted: false,
    deletedAt: null,
  };

  const product = await prisma.product.upsert({
    where: { siteId_externalId: { siteId, externalId: np.externalId } },
    update: common, // floristPrice не трогаем — сохраняем правки владельца
    create: { siteId, externalId: np.externalId, ...common }, // floristPrice = NULL (не задана → полная стоимость)
    select: { id: true, createdAt: true, updatedAt: true },
  });
  // createdAt===updatedAt на только что созданной записи (updatedAt ставится @updatedAt).
  const created = product.createdAt.getTime() === product.updatedAt.getTime();

  const seenVariantExternalIds = new Set<string>();
  for (const v of np.variants) {
    seenVariantExternalIds.add(v.externalId);
    const vCommon = {
      title: v.title,
      sku: v.sku,
      listPrice: dec(v.listPrice),
      compareAtPrice: v.compareAtPrice != null ? dec(v.compareAtPrice) : null,
      image: v.image,
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
      inventoryQty: v.inventoryQty,
      available: v.available,
      position: v.position,
      adminUrl: v.adminUrl,
      lastSyncedAt: now,
      lastSeenSyncRunId: runId,
      remoteDeleted: false,
      deletedAt: null,
    };
    await prisma.productVariant.upsert({
      where: { productId_externalId: { productId: product.id, externalId: v.externalId } },
      update: vCommon, // floristPrice варианта тоже не трогаем
      create: { productId: product.id, externalId: v.externalId, ...vCommon },
    });
  }

  return { created, seenVariantExternalIds };
}

async function writeProgress(
  siteId: string,
  patch: Prisma.SiteSyncUncheckedUpdateInput
): Promise<void> {
  await prisma.siteSync.update({ where: { siteId_kind: { siteId, kind: "PRODUCTS" } }, data: patch });
}

/**
 * Полная синхронизация каталога сайта. Идемпотентна (upsert по внешним id — без дублей).
 * remoteDeleted проставляется ТОЛЬКО после полностью успешного прохода по всему каталогу;
 * при обрыве уже импортированное сохраняется, ничего не скрывается.
 */
export async function syncProducts(siteId: string): Promise<ProductSyncResult> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, platform: true, shopifyShopDomain: true, shopifyAccessToken: true },
  });
  if (!site) throw new Error(`Сайт ${siteId} не найден`);

  // Guard от параллельного запуска.
  const existing = await prisma.siteSync.findUnique({
    where: { siteId_kind: { siteId, kind: "PRODUCTS" } },
  });
  if (
    existing?.status === "RUNNING" &&
    Date.now() - existing.startedAt.getTime() < STALE_RUNNING_MS
  ) {
    return { started: false, created: 0, updated: 0, skipped: 0, errors: 0, total: existing.total };
  }

  const now = new Date();
  await prisma.siteSync.upsert({
    where: { siteId_kind: { siteId, kind: "PRODUCTS" } },
    create: { siteId, kind: "PRODUCTS", status: "RUNNING", startedAt: now },
    update: {
      status: "RUNNING",
      startedAt: now,
      finishedAt: null,
      total: null,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      errorMessage: null,
    },
  });

  // Credentials — через единый resolver (CUSTOM_APP: token из tokenManager; legacy: stored).
  // runId помечает товары/варианты, встреченные в ЭТОМ прогоне; отсутствующие пометим
  // remoteDeleted только после ПОЛНОГО успешного прохода (см. ниже).
  const runId = crypto.randomUUID();
  let catalogSite: CatalogSite = { id: site.id, shopifyShopDomain: site.shopifyShopDomain, shopifyAccessToken: site.shopifyAccessToken };
  if (site.platform === "SHOPIFY") {
    try {
      const c = await resolveShopifyAccessToken(site.id);
      catalogSite = { id: site.id, shopifyShopDomain: c.shopDomain, shopifyAccessToken: c.accessToken };
    } catch {
      // legacy без резолвера / не подключён — оставляем site как есть (адаптер обработает).
    }
  }
  // WOOCOMMERCE: адаптер каталога сам резолвит credentials по site.id (shopify-поля не нужны).

  const adapter = getCatalogAdapter(site.platform);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let total: number | null = null;

  try {
    total = await adapter.countProducts(catalogSite);
    if (total != null) await writeProgress(siteId, { total });

    for await (const np of adapter.fetchProducts(catalogSite)) {
      try {
        if (!np.variants.length) {
          skipped++;
        } else {
          const { created: isNew } = await upsertProduct(siteId, np, now, runId);
          if (isNew) created++;
          else updated++;
        }
      } catch (err) {
        errors++;
        console.warn(`[catalog] ошибка импорта товара ${np.externalId}:`, err instanceof Error ? err.message : err);
      }
      processed++;
      if (processed % PROGRESS_EVERY === 0) {
        await writeProgress(siteId, { processed, created, updated, skipped, errors });
      }
    }

    // Пометка исчезнувших — ТОЛЬКО после ПОЛНОСТЬЮ чистого прохода:
    //  - processed>0: защита от «пустого» успешного ответа, скрывающего весь каталог;
    //  - errors===0: транзиентный сбой upsert'а отдельного товара НЕ должен пометить его
    //    remoteDeleted (его lastSeenSyncRunId не обновился) — ждём следующего чистого прогона.
    if (processed > 0 && errors === 0) {
      await markRemoteDeleted(siteId, runId, now);
    }

    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "PRODUCTS" } },
      data: {
        status: "DONE",
        processed,
        created,
        updated,
        skipped,
        errors,
        total,
        finishedAt: new Date(),
      },
    });
    return { started: true, created, updated, skipped, errors, total };
  } catch (err) {
    // Обрыв: НИЧЕГО не скрываем, уже импортированное остаётся, повторный запуск догонит.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalog] синхронизация сайта ${siteId} прервана:`, message);
    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "PRODUCTS" } },
      data: { status: "ERROR", errorMessage: message.slice(0, 500), processed, created, updated, skipped, errors, finishedAt: new Date() },
    });
    throw err;
  }
}

/**
 * Помечает remoteDeleted всё, что НЕ встретилось в текущем прогоне `runId`
 * (lastSeenSyncRunId != runId). Локальные floristPrice/composition НЕ трогаются.
 * Вызывается только после полного успешного прохода (см. syncProducts).
 */
async function markRemoteDeleted(siteId: string, runId: string, now: Date): Promise<void> {
  // Товары, не виденные в этом прогоне.
  await prisma.product.updateMany({
    where: { siteId, remoteDeleted: false, OR: [{ lastSeenSyncRunId: { not: runId } }, { lastSeenSyncRunId: null }] },
    data: { remoteDeleted: true, deletedAt: now },
  });
  // Варианты, не виденные в этом прогоне (исчезнувшие у существующих товаров ИЛИ у удалённых).
  await prisma.productVariant.updateMany({
    where: { product: { siteId }, remoteDeleted: false, OR: [{ lastSeenSyncRunId: { not: runId } }, { lastSeenSyncRunId: null }] },
    data: { remoteDeleted: true, deletedAt: now },
  });
}

/**
 * Запускает синхронизацию каталога в фоне (fire-and-forget) и сразу возвращается.
 * Деплой — long-running `next start` под pm2, поэтому detached-промис доживает до конца.
 */
export function startProductSyncInBackground(siteId: string): void {
  void syncProducts(siteId).catch((err) => {
    console.error(`[catalog] фоновая синхронизация ${siteId} упала:`, err instanceof Error ? err.message : err);
  });
}
