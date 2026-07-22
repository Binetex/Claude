import "server-only";
import type { CatalogAdapter } from "@/integrations/types";
import { shopifyCatalogAdapter } from "@/integrations/shopify/catalogAdapter";
import { wooCommerceCatalogAdapter } from "@/integrations/woocommerce/catalogAdapter";

/** Реестр адаптеров каталога по платформе сайта. Точка расширения для новых интеграций. */
export function getCatalogAdapter(platform: "SHOPIFY" | "WOOCOMMERCE"): CatalogAdapter {
  switch (platform) {
    case "SHOPIFY":
      return shopifyCatalogAdapter;
    case "WOOCOMMERCE":
      return wooCommerceCatalogAdapter;
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Нет адаптера каталога для платформы: ${_exhaustive}`);
    }
  }
}
