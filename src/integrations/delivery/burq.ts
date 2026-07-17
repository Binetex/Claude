import "server-only";
import type { DeliveryAdapter } from "@/integrations/types";
import { featureFlags } from "@/lib/featureFlags";

/** Заглушка адаптера доставки Burq (этап 1). Реальный вызов — этап 2, под флагом BURQ_ENABLED. */
export const burqAdapter: DeliveryAdapter = {
  async createDelivery(orderId) {
    if (!featureFlags.burq) {
      console.log(`[burq] интеграция выключена (BURQ_ENABLED=false), заглушка для заказа ${orderId}`);
    }
    // TODO(этап 2): создать доставку через Burq API.
    return { trackingUrl: `https://track.example.com/${orderId}` };
  },
  async getStatus() {
    return "PENDING";
  },
};
