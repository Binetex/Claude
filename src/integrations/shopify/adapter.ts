import type { OrderSourceAdapter, ExternalOrderPayload } from "@/integrations/types";
import { featureFlags } from "@/lib/featureFlags";

/** Заглушка адаптера Shopify (этап 1). Реальный Admin API/webhook — этап 2, под флагом SHOPIFY_ENABLED. */
export const shopifyAdapter: OrderSourceAdapter = {
  platform: "SHOPIFY",
  parseWebhook(body: unknown): ExternalOrderPayload {
    const b = body as { id?: string | number };
    return { externalId: String(b?.id ?? ""), raw: body };
  },
  async pushUpdate(externalId, changes) {
    if (!featureFlags.shopify) {
      console.log(`[shopify] интеграция выключена (SHOPIFY_ENABLED=false), пропуск pushUpdate ${externalId}`);
      return;
    }
    // TODO(этап 2): POST /admin/api/.../orders/{externalId}.json
    console.log(`[shopify] pushUpdate ${externalId}`, changes);
  },
};
