import type { OrderSourceAdapter, ExternalOrderPayload } from "@/integrations/types";
import { featureFlags } from "@/lib/featureFlags";

/** Заглушка адаптера WooCommerce (этап 1). Реальный REST/webhook — этап 2, под флагом WOOCOMMERCE_ENABLED. */
export const wooCommerceAdapter: OrderSourceAdapter = {
  platform: "WOOCOMMERCE",
  parseWebhook(body: unknown): ExternalOrderPayload {
    const b = body as { id?: string | number };
    return { externalId: String(b?.id ?? ""), raw: body };
  },
  async pushUpdate(externalId, changes) {
    if (!featureFlags.woocommerce) {
      console.log(`[woo] интеграция выключена (WOOCOMMERCE_ENABLED=false), пропуск pushUpdate ${externalId}`);
      return;
    }
    // TODO(этап 2): PUT /wp-json/wc/v3/orders/{externalId}
    console.log(`[woo] pushUpdate ${externalId}`, changes);
  },
};
