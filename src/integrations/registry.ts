import "server-only";
import type { OrderAdapter, WebhookAdapter, ConnectionAdapter } from "@/integrations/types";
import type { IntegrationPlatform } from "@/integrations/normalized";
import { shopifyOrderAdapter } from "@/integrations/shopify/orderAdapter";
import { shopifyWebhookAdapter } from "@/integrations/shopify/webhookAdapter";
import { shopifyConnectionAdapter } from "@/integrations/shopify/connectionAdapter";
import { wooCommerceOrderAdapter } from "@/integrations/woocommerce/orderAdapter";
import { wooCommerceWebhookAdapter } from "@/integrations/woocommerce/webhookAdapter";
import { wooCommerceConnectionAdapter } from "@/integrations/woocommerce/connectionAdapter";

/**
 * Единый реестр адаптеров по платформе. Точка расширения для новых интеграций: добавление
 * платформы = регистрация адаптеров здесь, exhaustive switch не даст забыть ветку.
 * Дополняет существующий `catalog.ts` (реестр каталога).
 */

function unsupported(platform: never, kind: string): never {
  throw new Error(`Нет ${kind}-адаптера для платформы: ${String(platform)}`);
}

export function getOrderAdapter(platform: IntegrationPlatform): OrderAdapter {
  switch (platform) {
    case "SHOPIFY":
      return shopifyOrderAdapter;
    case "WOOCOMMERCE":
      return wooCommerceOrderAdapter;
    default:
      return unsupported(platform, "order");
  }
}

export function getWebhookAdapter(platform: IntegrationPlatform): WebhookAdapter {
  switch (platform) {
    case "SHOPIFY":
      return shopifyWebhookAdapter;
    case "WOOCOMMERCE":
      return wooCommerceWebhookAdapter;
    default:
      return unsupported(platform, "webhook");
  }
}

export function getConnectionAdapter(platform: IntegrationPlatform): ConnectionAdapter {
  switch (platform) {
    case "SHOPIFY":
      return shopifyConnectionAdapter;
    case "WOOCOMMERCE":
      return wooCommerceConnectionAdapter;
    default:
      return unsupported(platform, "connection");
  }
}
