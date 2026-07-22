import "server-only";
import type {
  CatalogAdapter,
  CatalogSite,
  NormalizedProduct,
  NormalizedProductStatus,
  NormalizedVariant,
} from "@/integrations/types";

const API_VERSION = "2026-07";
const PAGE_SIZE = 250; // максимум Shopify REST
const PAGE_DELAY_MS = 350; // мягкий троттлинг (лимит ~2 req/s)

// ── Сырые формы ответа Shopify (только нужные поля) ──
type ShopifyImage = { id?: number | string; src: string; variant_ids?: (number | string)[] };
type ShopifyVariant = {
  id: number | string;
  title?: string;
  sku?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  position?: number | null;
  image_id?: number | string | null;
  inventory_quantity?: number | null;
  inventory_management?: string | null;
  inventory_policy?: string | null;
};
export type ShopifyProduct = {
  id: number | string;
  title?: string;
  handle?: string | null; // slug витрины: /products/{handle}
  status?: string | null;
  product_type?: string | null;
  image?: { src?: string } | null;
  images?: ShopifyImage[];
  variants?: ShopifyVariant[];
};

function toStatus(raw: string | null | undefined): NormalizedProductStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "draft":
      return "DRAFT";
    case "archived":
      return "ARCHIVED";
    default:
      return "ACTIVE";
  }
}

function toNum(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Достаёт page_info следующей страницы из заголовка Link (курсорная пагинация Shopify). */
function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) {
      try {
        return new URL(m[1]).searchParams.get("page_info");
      } catch {
        return null;
      }
    }
  }
  return null;
}

function requireCreds(site: CatalogSite): { shop: string; token: string } {
  if (!site.shopifyShopDomain || !site.shopifyAccessToken) {
    throw new Error("Shopify: у сайта нет домена/токена — переподключите магазин.");
  }
  return { shop: site.shopifyShopDomain, token: site.shopifyAccessToken };
}

function normalizeVariant(
  shop: string,
  productId: string,
  productActive: boolean,
  imageByVariantId: Map<string, string>,
  imageById: Map<string, string>,
  v: ShopifyVariant
): NormalizedVariant {
  const externalId = String(v.id);
  const variantImage =
    imageByVariantId.get(externalId) ??
    (v.image_id != null ? imageById.get(String(v.image_id)) : undefined) ??
    null;

  // Доступность: товар активен И (нет управления запасами ИЛИ есть остаток ИЛИ разрешён овердрафт).
  const hasStockMgmt = !!v.inventory_management;
  const qty = v.inventory_quantity ?? null;
  const available =
    productActive &&
    (!hasStockMgmt || qty == null || qty > 0 || v.inventory_policy === "continue");

  return {
    externalId,
    title: v.title?.trim() || "Default Title",
    sku: v.sku?.trim() || null,
    listPrice: toNum(v.price),
    compareAtPrice: v.compare_at_price != null && v.compare_at_price !== "" ? toNum(v.compare_at_price) : null,
    image: variantImage,
    option1: v.option1 ?? null,
    option2: v.option2 ?? null,
    option3: v.option3 ?? null,
    inventoryQty: qty,
    available,
    position: v.position ?? null,
    adminUrl: `https://${shop}/admin/products/${productId}/variants/${externalId}`,
  };
}

export function normalizeProduct(shop: string, p: ShopifyProduct): NormalizedProduct {
  const externalId = String(p.id);
  const status = toStatus(p.status);
  const productActive = status === "ACTIVE";

  const images = p.images ?? [];
  const imageByVariantId = new Map<string, string>();
  const imageById = new Map<string, string>();
  for (const img of images) {
    if (img.id != null) imageById.set(String(img.id), img.src);
    for (const vid of img.variant_ids ?? []) imageByVariantId.set(String(vid), img.src);
  }

  const variants = (p.variants ?? []).map((v) =>
    normalizeVariant(shop, externalId, productActive, imageByVariantId, imageById, v)
  );

  return {
    externalId,
    name: p.title?.trim() || "Без названия",
    image: p.image?.src ?? images[0]?.src ?? null,
    status,
    productType: p.product_type?.trim() || null,
    adminUrl: `https://${shop}/admin/products/${externalId}`,
    // Витрина открывается только по handle — по числовому id Shopify страницу не отдаёт.
    // Домен myshopify.com редиректит на основной домен магазина, если он настроен.
    onlineUrl: p.handle ? `https://${shop}/products/${p.handle}` : null,
    variants,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const shopifyCatalogAdapter: CatalogAdapter = {
  platform: "SHOPIFY",

  async countProducts(site) {
    const { shop, token } = requireCreds(site);
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/products/count.json`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    if (!res.ok) return null; // не критично — прогресс просто без total
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : null;
  },

  async *fetchProducts(site) {
    const { shop, token } = requireCreds(site);
    let pageInfo: string | null = null;

    do {
      // fields ограничивает ответ — body_html (Shopify description) НЕ запрашиваем вовсе.
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        fields: "id,title,handle,status,product_type,image,images,variants",
      });
      // При курсорной пагинации Shopify разрешает только limit, fields и page_info.
      if (pageInfo) params.set("page_info", pageInfo);

      const res = await fetch(
        `https://${shop}/admin/api/${API_VERSION}/products.json?${params.toString()}`,
        { headers: { "X-Shopify-Access-Token": token } }
      );
      if (!res.ok) {
        const hint = res.status === 403 ? " (нет прав read_products — переподключите магазин)" : "";
        throw new Error(`Shopify products.json: ${res.status}${hint}`);
      }

      const data = (await res.json()) as { products?: ShopifyProduct[] };
      for (const p of data.products ?? []) {
        yield normalizeProduct(shop, p);
      }

      pageInfo = nextPageInfo(res.headers.get("link"));
      if (pageInfo) await sleep(PAGE_DELAY_MS);
    } while (pageInfo);
  },
};
