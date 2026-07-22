import "server-only";
/**
 * Каталог WooCommerce: `GET /products` + для variable-товаров `GET /products/{id}/variations`,
 * с пагинацией по всем страницам. Отдаёт тот же контракт `CatalogAdapter`, что и Shopify,
 * поэтому sync-движок (modules/catalog/sync.ts) и UI не меняются.
 *
 * Правила проекта:
 *  - description WooCommerce НЕ импортируем (нигде не показываем);
 *  - simple-товар представляем ОДНИМ синтетическим вариантом (единая модель ProductVariant);
 *  - variable-товар — всеми вариациями; цена варианта = актуальная (`price`), `regular_price`
 *    как compareAtPrice при распродаже;
 *  - ключи: externalId = Woo product id; вариант externalId = variation id (или product id
 *    для simple). SKU/title НЕ ключи.
 */
import type {
  CatalogAdapter,
  CatalogSite,
  NormalizedProduct,
  NormalizedProductStatus,
  NormalizedVariant,
} from "@/integrations/types";
import { resolveWooCredentials, type WooCredentials } from "./credentials";
import { wooGet, type WooClientOptions } from "./client";

const PAGE_SIZE = 100; // максимум per_page WooCommerce

// ── Сырые формы WooCommerce (только нужные поля; description не запрашиваем/не читаем) ──
type WooImage = { src?: string };
type WooAttr = { name?: string; option?: string; options?: string[] };
export type WooProduct = {
  id: number | string;
  name?: string;
  slug?: string;
  permalink?: string;
  type?: string; // "simple" | "variable" | "grouped" | "external"
  status?: string; // "publish" | "draft" | "pending" | "private"
  price?: string | number;
  regular_price?: string | number;
  sale_price?: string | number;
  on_sale?: boolean;
  sku?: string;
  stock_status?: string; // "instock" | "outofstock" | "onbackorder"
  stock_quantity?: number | null;
  images?: WooImage[];
  attributes?: WooAttr[];
  variations?: (number | string)[]; // id вариаций (для variable)
  date_modified_gmt?: string;
};
export type WooVariation = {
  id: number | string;
  sku?: string;
  price?: string | number;
  regular_price?: string | number;
  sale_price?: string | number;
  on_sale?: boolean;
  status?: string;
  stock_status?: string;
  stock_quantity?: number | null;
  image?: WooImage | null;
  attributes?: WooAttr[];
  menu_order?: number;
};

function toNum(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function mapWooProductStatus(s: string | undefined): NormalizedProductStatus {
  switch ((s ?? "").toLowerCase()) {
    case "publish":
      return "ACTIVE";
    case "trash":
      return "ARCHIVED";
    default:
      return "DRAFT"; // draft/pending/private
  }
}

function attrTitle(attrs: WooAttr[] | undefined): { title: string; opts: (string | null)[] } {
  const opts = (attrs ?? [])
    .map((a) => a.option?.trim() || (a.options && a.options[0]) || null)
    .filter((x): x is string => !!x);
  const title = opts.join(" / ").trim();
  return { title: title || "Default Title", opts: [opts[0] ?? null, opts[1] ?? null, opts[2] ?? null] };
}

/** Актуальная цена варианта и compareAt (перечёркнутая) из regular/sale. */
function priceOf(src: { price?: string | number; regular_price?: string | number; sale_price?: string | number; on_sale?: boolean }): {
  listPrice: number;
  compareAtPrice: number | null;
} {
  const price = toNum(src.price ?? src.sale_price ?? src.regular_price);
  const regular = toNum(src.regular_price);
  const onSale = src.on_sale === true || (regular > 0 && price > 0 && price < regular);
  return { listPrice: price, compareAtPrice: onSale && regular > price ? regular : null };
}

function isAvailable(productPublished: boolean, stockStatus: string | undefined): boolean {
  return productPublished && (stockStatus == null || stockStatus === "instock" || stockStatus === "onbackorder");
}

export function normalizeWooVariation(p: WooProduct, v: WooVariation, published: boolean): NormalizedVariant {
  const { title, opts } = attrTitle(v.attributes);
  const { listPrice, compareAtPrice } = priceOf(v);
  return {
    externalId: String(v.id),
    title,
    sku: v.sku?.trim() || null,
    listPrice,
    compareAtPrice,
    image: v.image?.src ?? null,
    option1: opts[0],
    option2: opts[1],
    option3: opts[2],
    inventoryQty: v.stock_quantity ?? null,
    available: isAvailable(published, v.stock_status),
    position: v.menu_order ?? null,
    adminUrl: p.permalink ?? null,
  };
}

/** simple-товар → один синтетический вариант (externalId = product id). */
export function normalizeSimpleAsVariant(p: WooProduct, published: boolean): NormalizedVariant {
  const { listPrice, compareAtPrice } = priceOf(p);
  return {
    externalId: String(p.id),
    title: "Default Title",
    sku: p.sku?.trim() || null,
    listPrice,
    compareAtPrice,
    image: p.images?.[0]?.src ?? null,
    option1: null,
    option2: null,
    option3: null,
    inventoryQty: p.stock_quantity ?? null,
    available: isAvailable(published, p.stock_status),
    position: 0,
    adminUrl: p.permalink ?? null,
  };
}

export function normalizeWooProduct(p: WooProduct, variations: WooVariation[]): NormalizedProduct {
  const status = mapWooProductStatus(p.status);
  const published = status === "ACTIVE";
  const variants: NormalizedVariant[] =
    (p.type ?? "simple") === "variable" && variations.length
      ? variations.map((v) => normalizeWooVariation(p, v, published))
      : [normalizeSimpleAsVariant(p, published)];

  return {
    externalId: String(p.id),
    name: p.name?.trim() || "Без названия",
    image: p.images?.[0]?.src ?? null,
    status,
    productType: p.type?.trim() || null,
    adminUrl: p.permalink ?? null,
    onlineUrl: p.permalink ?? null,
    variants,
  };
}

/** Собирает все вариации одного товара (для webhook product.updated variable-товара). */
export async function collectWooVariations(creds: WooCredentials, productId: string, opts: WooClientOptions = {}): Promise<WooVariation[]> {
  const out: WooVariation[] = [];
  for await (const v of fetchVariations(creds, productId, opts)) out.push(v);
  return out;
}

/** Постранично тянет вариации variable-товара. */
async function* fetchVariations(creds: WooCredentials, productId: string, opts: WooClientOptions): AsyncGenerator<WooVariation> {
  let page = 1;
  for (;;) {
    const { data, totalPages } = await wooGet<WooVariation[]>(
      creds,
      `/products/${productId}/variations`,
      { per_page: PAGE_SIZE, page },
      opts
    );
    for (const v of data ?? []) yield v;
    if (!data || data.length < PAGE_SIZE || (totalPages != null && page >= totalPages)) break;
    page++;
  }
}

/**
 * Постранично отдаёт нормализованные товары со всеми вариациями. `opts.fetchImpl` инъектируется
 * в тестах (мок WooCommerce), в проде — реальный fetch.
 */
export async function* fetchWooProductsWith(creds: WooCredentials, opts: WooClientOptions = {}): AsyncGenerator<NormalizedProduct> {
  let page = 1;
  for (;;) {
    const { data, totalPages } = await wooGet<WooProduct[]>(creds, "/products", { per_page: PAGE_SIZE, page }, opts);
    for (const p of data ?? []) {
      const variations: WooVariation[] = [];
      if ((p.type ?? "simple") === "variable") {
        for await (const v of fetchVariations(creds, String(p.id), opts)) variations.push(v);
      }
      yield normalizeWooProduct(p, variations);
    }
    if (!data || data.length < PAGE_SIZE || (totalPages != null && page >= totalPages)) break;
    page++;
  }
}

export const wooCommerceCatalogAdapter: CatalogAdapter = {
  platform: "WOOCOMMERCE",

  async countProducts(site: CatalogSite) {
    const creds = await resolveWooCredentials(site.id);
    const { total } = await wooGet<WooProduct[]>(creds, "/products", { per_page: 1 });
    return total;
  },

  async *fetchProducts(site: CatalogSite) {
    const creds = await resolveWooCredentials(site.id);
    yield* fetchWooProductsWith(creds);
  },
};
