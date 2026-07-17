import "server-only";
import type { CatalogAdapter } from "@/integrations/types";

/**
 * Заглушка каталога WooCommerce (этап 1). Реальный REST `/wp-json/wc/v3/products`
 * с вариациями — этап 2. Реализует тот же контракт, что и Shopify, поэтому sync-движок
 * и UI при подключении Woo менять не придётся.
 */
export const wooCommerceCatalogAdapter: CatalogAdapter = {
  platform: "WOOCOMMERCE",
  async countProducts() {
    return null;
  },
  // eslint-disable-next-line require-yield
  async *fetchProducts() {
    throw new Error("WooCommerce каталог ещё не реализован (этап 2).");
  },
};
