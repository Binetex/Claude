import "server-only";
import type { ConnectionAdapter, ConnectionCredentials, ConnectionState } from "@/integrations/types";

/**
 * Shopify как реализация `ConnectionAdapter`. Полноценная проверка (`GET /admin/api/.../shop.json`)
 * уже существует в потоке OAuth; здесь — единый контракт для реестра. Ночью без сетевого вызова:
 * статус выводится из наличия per-site credentials (домен + access token).
 */
export const shopifyConnectionAdapter: ConnectionAdapter = {
  platform: "SHOPIFY",
  async checkStatus(creds: ConnectionCredentials): Promise<ConnectionState> {
    if (creds.shopDomain && creds.accessToken) return "CONNECTED";
    if (creds.shopDomain) return "PENDING";
    return "DISCONNECTED";
  },
};
