import "server-only";
/**
 * ИНКРЕМЕНТАЛЬНАЯ синхронизация заказов WooCommerce с watermark `lastOrderSyncAt`.
 * Прогресс — в SiteSync(kind=ORDERS), идемпотентна (ingestWooOrder upsert по siteId+externalId).
 * При частичном сбое → ERROR, уже импортированное сохраняется, повтор безопасен.
 *
 * Границы выборки (см. computeOrderSyncBound):
 *  - fullHistory (явная «Полная синхронизация» с подтверждением) → вся история, watermark игнорируется;
 *  - watermark есть → только изменённое после него (`modified_after` — ловит и новые, и обновления);
 *  - watermark пуст (первая синхронизация) → начальное окно INITIAL_WINDOW_DAYS (14 дней).
 * После успешного прохода watermark продвигается на время старта прохода.
 *
 * Дедуп/externalUpdatedAt/anti-rollback живут в ingestWooOrder и здесь НЕ меняются.
 * Запускается фоново (worker/outbox), НЕ внутри HTTP-запроса страницы.
 */
import { prisma } from "@/lib/db";
import { resolveWooCredentials } from "./credentials";
import { loadWooIngestConfig } from "./config";
import { countWooOrders, fetchWooOrders, type WooOrderBound } from "./orderFetch";
import { ingestWooOrder } from "./ingestWooOrder";

const STALE_RUNNING_MS = 15 * 60 * 1000;
const PROGRESS_EVERY = 10;
export const INITIAL_WINDOW_DAYS = 14; // окно первой синхронизации при пустом watermark

/**
 * Чистое вычисление границы выборки заказов. Тестируемо.
 *  - fullHistory → {} (вся история);
 *  - watermark → modified_after (инкрементально);
 *  - иначе → after = now − windowDays (начальное окно).
 */
export function computeOrderSyncBound(
  lastOrderSyncAt: Date | null,
  fullHistory: boolean,
  now: Date,
  windowDays: number = INITIAL_WINDOW_DAYS
): WooOrderBound {
  if (fullHistory) return {};
  if (lastOrderSyncAt) return { modifiedAfter: lastOrderSyncAt.toISOString() };
  return { after: new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString() };
}

export async function syncWooOrders(siteId: string, opts: { fullHistory?: boolean } = {}): Promise<void> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, shortName: true, platform: true } });
  if (!site) throw new Error(`Сайт ${siteId} не найден`);
  if (site.platform !== "WOOCOMMERCE") throw new Error(`syncWooOrders вызван для не-Woo сайта ${siteId}`);

  const existing = await prisma.siteSync.findUnique({ where: { siteId_kind: { siteId, kind: "ORDERS" } } });
  if (existing?.status === "RUNNING" && Date.now() - existing.startedAt.getTime() < STALE_RUNNING_MS) return;

  const now = new Date();
  await prisma.siteSync.upsert({
    where: { siteId_kind: { siteId, kind: "ORDERS" } },
    create: { siteId, kind: "ORDERS", status: "RUNNING", startedAt: now },
    update: { status: "RUNNING", startedAt: now, finishedAt: null, total: null, processed: 0, created: 0, updated: 0, skipped: 0, errors: 0, errorMessage: null },
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let total: number | null = null;

  try {
    const creds = await resolveWooCredentials(siteId);
    const config = await loadWooIngestConfig(siteId);
    // Watermark: время последней успешной синхронизации заказов этого магазина.
    const conn = await prisma.wooCommerceConnection.findUnique({ where: { siteId }, select: { lastOrderSyncAt: true } });
    const bound = computeOrderSyncBound(conn?.lastOrderSyncAt ?? null, opts.fullHistory ?? false, now);

    total = await countWooOrders(creds, bound);
    if (total != null) await prisma.siteSync.update({ where: { siteId_kind: { siteId, kind: "ORDERS" } }, data: { total } });

    for await (const order of fetchWooOrders(creds, bound)) {
      try {
        const res = await ingestWooOrder(site, order as never, config);
        if (res.status === "created") created++;
        else if (res.status === "updated") updated++;
        else skipped++;
      } catch (err) {
        errors++;
        console.warn(`[woo] ошибка импорта заказа ${(order as { id?: unknown }).id}:`, err instanceof Error ? err.message : err);
      }
      processed++;
      if (processed % PROGRESS_EVERY === 0) {
        await prisma.siteSync.update({ where: { siteId_kind: { siteId, kind: "ORDERS" } }, data: { processed, created, updated, skipped, errors } });
      }
    }

    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "ORDERS" } },
      data: { status: "DONE", processed, created, updated, skipped, errors, total, finishedAt: new Date() },
    });
    // Watermark продвигаем ТОЛЬКО после успешного прохода, на время СТАРТА прохода (`now`) —
    // лёгкое перекрытие безопаснее пропуска (ingest идемпотентен). При частичном сбое (catch)
    // watermark НЕ двигаем — следующий запуск повторит окно и догонит пропущенное.
    await prisma.wooCommerceConnection.update({ where: { siteId }, data: { lastOrderSyncAt: now } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[woo] синхронизация заказов сайта ${siteId} прервана:`, message);
    await prisma.siteSync.update({
      where: { siteId_kind: { siteId, kind: "ORDERS" } },
      data: { status: "ERROR", errorMessage: message.slice(0, 500), processed, created, updated, skipped, errors, finishedAt: new Date() },
    });
    throw err;
  }
}
