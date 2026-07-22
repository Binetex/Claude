/**
 * Диспетчер Shopify webhook-события из outbox по topic. Дедупликация уже обеспечена outbox'ом
 * (idempotencyKey = shopify:webhook:{siteId}:{webhookId}) — повторная доставка того же события
 * не переисполняется. Здесь — маршрутизация topic → обработчик. Обработчики инъектируются,
 * поэтому маршрутизация полностью тестируема без БД/сети.
 *
 * Топики подтверждены по официальной GraphQL-схеме Shopify (WebhookSubscriptionTopic).
 */
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";

export type ShopifyWebhookPayload = {
  siteId: string;
  topic: string | null;
  webhookId: string;
  shopify: unknown;
};

export type ShopifyWebhookHandlerDeps = {
  /** orders/create, orders/updated, orders/cancelled, orders/fulfilled — с out-of-order guard внутри. */
  ingestOrder: (siteId: string, topic: string, shopify: unknown) => Promise<void>;
  /** refunds/create → обновление статуса заказа (возврат). */
  applyRefund: (siteId: string, shopify: unknown) => Promise<void>;
  /** products/create, products/update → upsert товара (локальные поля не перезаписываются). */
  upsertProduct: (siteId: string, shopify: unknown) => Promise<void>;
  /** products/delete → remoteDeleted=true (не физическое удаление). */
  markProductDeleted: (siteId: string, shopify: unknown) => Promise<void>;
  /** app/uninstalled → REAUTH_REQUIRED/DISCONNECTED, остановить sync, ничего не удалять. */
  handleAppUninstalled: (siteId: string) => Promise<void>;
  /** app/scopes_update → перепроверить фактические scopes. */
  handleScopesUpdate?: (siteId: string) => Promise<void>;
};

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/cancelled", "orders/fulfilled"]);

export function buildShopifyWebhookHandler(deps: ShopifyWebhookHandlerDeps): OutboxHandler {
  return async (record: OutboxRecord) => {
    const { siteId, topic, shopify } = (record.payload ?? {}) as ShopifyWebhookPayload;
    if (!siteId || !topic) return; // некорректный payload — нечего делать

    if (ORDER_TOPICS.has(topic)) {
      await deps.ingestOrder(siteId, topic, shopify);
      return;
    }
    switch (topic) {
      case "refunds/create":
        await deps.applyRefund(siteId, shopify);
        return;
      case "products/create":
      case "products/update":
        await deps.upsertProduct(siteId, shopify);
        return;
      case "products/delete":
        await deps.markProductDeleted(siteId, shopify);
        return;
      case "app/uninstalled":
        await deps.handleAppUninstalled(siteId);
        return;
      case "app/scopes_update":
        await deps.handleScopesUpdate?.(siteId);
        return;
      default:
        // Неизвестный/неподдерживаемый topic — считаем обработанным (не крутим повторно).
        return;
    }
  };
}
