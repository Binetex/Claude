import "server-only";

const API_VERSION = "2026-07";

// Резолвит только картинки позиций заказа. Shopify description (body_html) не запрашивается и не хранится.
export type ProductImageInfo = { defaultSrc: string | null; byVariantId: Map<string, string> };
export type ProductImageCache = Map<string, ProductImageInfo | null>;

export function createProductImageCache(): ProductImageCache {
  return new Map();
}

type ShopifyProductImagesResponse = {
  product?: {
    images?: { src: string; variant_ids?: (number | string)[] }[];
  };
};

/**
 * Требует scope `read_products` (см. oauth.ts). Токены, выданные до его добавления,
 * получат 403 — это ожидаемо до тех пор, пока владелец не переподключит магазин через
 * /dashboard/sites. Ошибка не должна ронять приём заказа — только логируется.
 */
async function fetchProductImages(
  shopDomain: string,
  accessToken: string,
  productId: string
): Promise<ProductImageInfo | null> {
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${API_VERSION}/products/${productId}.json?fields=id,images`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!res.ok) {
      console.warn(
        `[shopify] не удалось получить данные товара ${productId} для ${shopDomain}: ${res.status}` +
          (res.status === 403 ? " (нет прав read_products — переподключите магазин)" : "")
      );
      return null;
    }
    const body = (await res.json()) as ShopifyProductImagesResponse;
    const images = body.product?.images ?? [];
    const byVariantId = new Map<string, string>();
    for (const img of images) {
      for (const variantId of img.variant_ids ?? []) {
        byVariantId.set(String(variantId), img.src);
      }
    }
    return { defaultSrc: images[0]?.src ?? null, byVariantId };
  } catch (err) {
    console.warn(`[shopify] ошибка запроса данных товара ${productId} для ${shopDomain}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Резолвит картинку для каждой позиции заказа (по variant_id, с fallback на product_id)
 * одним HTTP-запросом на уникальный товар (не на позицию). `cache` можно переиспользовать
 * между несколькими заказами одного прогона (см. scripts/backfill-shopify-orders.ts), чтобы
 * не запрашивать один и тот же товар повторно.
 */
export async function resolveLineItemImages(
  shopDomain: string,
  accessToken: string,
  lineItems: { product_id?: number | string | null; variant_id?: number | string | null }[],
  cache: ProductImageCache
): Promise<Map<string, string>> {
  const productIds = [...new Set(lineItems.map((li) => li.product_id).filter((v): v is number | string => v !== null && v !== undefined).map(String))];

  for (const productId of productIds) {
    if (!cache.has(productId)) {
      cache.set(productId, await fetchProductImages(shopDomain, accessToken, productId));
    }
  }

  const result = new Map<string, string>();
  for (const li of lineItems) {
    const productId = li.product_id !== null && li.product_id !== undefined ? String(li.product_id) : undefined;
    const info = productId ? cache.get(productId) : undefined;
    if (!info) continue;
    const variantId = li.variant_id !== null && li.variant_id !== undefined ? String(li.variant_id) : undefined;
    const src = (variantId && info.byVariantId.get(variantId)) || info.defaultSrc;
    if (src && productId) result.set(productId, src);
    if (src && variantId) result.set(variantId, src);
  }
  return result;
}
