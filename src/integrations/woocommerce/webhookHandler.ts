import "server-only";
/**
 * Worker-обработчик события `woo.webhook.received` из outbox. Дедуп уже обеспечен outbox'ом
 * (idempotencyKey = woo:webhook:{siteId}:{deliveryId}). Здесь — маршрутизация topic → действие.
 * Топики WooCommerce: order.created|updated|deleted, product.created|updated|deleted.
 */
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { prisma } from "@/lib/db";
import { resolveWooCredentials } from "./credentials";
import { loadWooIngestConfig } from "./config";
import { ingestWooOrder, markWooOrderDeleted } from "./ingestWooOrder";
import { upsertWooProduct, markWooProductDeleted } from "./productWrite";
import { normalizeWooProduct, collectWooVariations, type WooProduct, type WooVariation } from "./catalogAdapter";

type WooWebhookPayload = { siteId: string; topic: string; deliveryId: string; woo: unknown };

async function handleOrderUpsert(siteId: string, woo: unknown): Promise<void> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, shortName: true } });
  if (!site) return;
  const config = await loadWooIngestConfig(siteId);
  await ingestWooOrder(site, woo as never, config);
}

async function handleProductUpsert(siteId: string, woo: unknown): Promise<void> {
  const p = woo as WooProduct;
  let variations: WooVariation[] = [];
  if ((p.type ?? "simple") === "variable") {
    // В webhook variable-товара приходят только id вариаций — догружаем полные данные.
    try {
      const creds = await resolveWooCredentials(siteId);
      variations = await collectWooVariations(creds, String(p.id));
    } catch {
      variations = []; // без вариаций — сохранится как один синтетический вариант (лучше, чем пусто)
    }
  }
  await upsertWooProduct(siteId, normalizeWooProduct(p, variations));
}

export function buildWooWebhookHandler(): OutboxHandler {
  return async (record: OutboxRecord) => {
    const { siteId, topic, woo } = (record.payload ?? {}) as WooWebhookPayload;
    if (!siteId || !topic) return;
    const wooId = (woo as { id?: unknown })?.id;

    switch (topic) {
      case "order.created":
      case "order.updated":
        await handleOrderUpsert(siteId, woo);
        return;
      case "order.deleted":
        if (wooId != null) await markWooOrderDeleted(siteId, String(wooId));
        return;
      case "product.created":
      case "product.updated":
        await handleProductUpsert(siteId, woo);
        return;
      case "product.deleted":
        if (wooId != null) await markWooProductDeleted(siteId, String(wooId));
        return;
      default:
        return; // неизвестный topic — считаем обработанным
    }
  };
}
