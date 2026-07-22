import "server-only";
import type { ConnectionAdapter, ConnectionCredentials, ConnectionState } from "@/integrations/types";
import { featureFlags } from "@/lib/featureFlags";

/**
 * Skeleton-адаптер подключения WooCommerce. Реальный ping (`GET /wp-json/wc/v3/system_status`)
 * — этап 2 под флагом `WOOCOMMERCE_ENABLED`. Пока определяет статус по наличию credentials,
 * без сетевого вызова (безопасно ночью).
 */
export const wooCommerceConnectionAdapter: ConnectionAdapter = {
  platform: "WOOCOMMERCE",
  async checkStatus(creds: ConnectionCredentials): Promise<ConnectionState> {
    if (!creds.shopDomain || !creds.accessToken) return "DISCONNECTED";
    if (!featureFlags.woocommerce) return "PENDING"; // credentials есть, но интеграция не включена
    // TODO(этап 2): реальный ping системного статуса Woo.
    return "PENDING";
  },
};
