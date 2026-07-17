import "server-only";
import { prisma } from "@/lib/db";
import { backfillShopifyOrder } from "@/integrations/shopify/ingestOrder";
import { createProductImageCache } from "@/integrations/shopify/productImages";
import { countOrdersSince, fetchOrdersSince } from "@/integrations/shopify/orders";

const STALE_RUNNING_MS = 15 * 60 * 1000;
const PROGRESS_EVERY = 10;
const WINDOW_DAYS = 90; // окно синхронизации заказов по кнопке

/**
 * Синхронизация заказов сайта (последнее окно). Идемпотентна: backfillShopifyOrder
 * пропускает уже существующие заказы (без дублей). Прогресс — в SiteSync(kind=ORDERS).
 * Универсальная точка входа; сейчас реализован Shopify, Woo — этап 2.
 */
export async function syncOrders(siteId: string): Promise<void> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) throw new Error(`Сайт ${siteId} не найден`);

  const existing = await prisma.siteSync.findUnique({
    where: { siteId_kind: { siteId, kind: "ORDERS" } },
  });
  if (existing?.status === "RUNNING" && Date.now() - existing.startedAt.getTime() < STALE_RUNNING_MS) {
    return; // уже идёт
  }

  const now = new Date();
  await prisma.siteSync.upsert({
    where: { siteId_kind: { siteId, kind: "ORDERS" } },
    create: { siteId, kind: "ORDERS", status: "RUNNING", startedAt: now },
    update: {
      status: "RUNNING", startedAt: now, finishedAt: null, total: null,
      processed: 0, created: 0, updated: 0, skipped: 0, errors: 0, errorMessage: null,
    },
  });

  let created = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let total: number | null = null;

  try {
    if (site.platform !== "SHOPIFY") throw new Error(`Синхронизация заказов для ${site.platform} ещё не реализована (этап 2).`);
    if (!site.shopifyShopDomain || !site.shopifyAccessToken) throw new Error("У сайта нет домена/токена Shopify — переподключите магазин.");

    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    total = await countOrdersSince(site.shopifyShopDomain, site.shopifyAccessToken, sinceIso);
    if (total != null) {
      await prisma.siteSync.update({ where: { siteId_kind: { siteId, kind: "ORDERS" } }, data: { total } });
    }

    const imageCache = createProductImageCache();
    const siteLite = {
      id: site.id,
      shortName: site.shortName,
      shopifyShopDomain: site.shopifyShopDomain,
      shopifyAccessToken: site.shopifyAccessToken,
    };

    for await (const order of fetchOrdersSince(site.shopifyShopDomain, site.shopifyAccessToken, sinceIso)) {
      try {
        const res = await backfillShopifyOrder(siteLite, order, imageCache);
        if (res.status === "created") created++;
        else skipped++;
      } catch (err) {
        errors++;
        console.warn(`[orders] ошибка импорта заказа ${order.id}:`, err instanceof Error ? err.message : err);
      }
      processed++;
      if (processed % PROGRESS_EVERY === 0) {
        await prisma.siteSync.update({
          where: { siteId_kind: { siteId, kind: "ORDERS" } },
          data: { processed, created, skipped, errors },
        });
      }
    }

    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "ORDERS" } },
      data: { status: "DONE", processed, created, skipped, errors, total, finishedAt: new Date() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orders] синхронизация сайта ${siteId} прервана:`, message);
    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "ORDERS" } },
      data: { status: "ERROR", errorMessage: message.slice(0, 500), processed, created, skipped, errors, finishedAt: new Date() },
    });
    throw err;
  }
}

export function startOrderSyncInBackground(siteId: string): void {
  void syncOrders(siteId).catch((err) => {
    console.error(`[orders] фоновая синхронизация ${siteId} упала:`, err instanceof Error ? err.message : err);
  });
}
