/**
 * Контракты адаптеров внешних систем.
 * Бизнес-логика зависит ТОЛЬКО от этих интерфейсов, а не от конкретных API.
 * На этапе 1 реализации — заглушки; позже подключаются реальные Shopify/Woo/Quo/Burq.
 */

export type ExternalOrderPayload = {
  externalId: string;
  raw: unknown;
};

/** Источник заказов (WooCommerce / Shopify). */
export interface OrderSourceAdapter {
  platform: "WOOCOMMERCE" | "SHOPIFY";
  /** Разобрать сырое тело вебхука во внутренний вид (этап 2). */
  parseWebhook(body: unknown): ExternalOrderPayload;
  /** Отправить разрешённые изменения обратно на сайт (дата доставки, статус). */
  pushUpdate(externalId: string, changes: Record<string, unknown>): Promise<void>;
}

/** Сообщения клиентам (Quo): SMS/email. */
export interface MessagingAdapter {
  sendSms(to: string, body: string): Promise<void>;
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

/** Доставка (Burq). */
export interface DeliveryAdapter {
  createDelivery(orderId: string): Promise<{ trackingUrl: string }>;
  getStatus(trackingId: string): Promise<string>;
}

// ───────────────────────────  КАТАЛОГ ТОВАРОВ  ───────────────────────────
//
// Единый контракт импорта товаров/вариантов. Sync-движок и UI зависят ТОЛЬКО
// от этих типов — конкретика Shopify/WooCommerce живёт в адаптерах. Добавление
// WooCommerce не требует изменений в движке синхронизации или интерфейсе.

/** Минимум данных сайта, нужный адаптеру каталога (без завязки на Prisma-модель). */
export type CatalogSite = {
  id: string;
  shopifyShopDomain: string | null;
  shopifyAccessToken: string | null;
};

export type NormalizedProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export type NormalizedVariant = {
  externalId: string; // id варианта во внешней системе
  title: string; // напр. "Small / Red" или "Default Title"
  sku: string | null;
  listPrice: number; // цена сайта
  compareAtPrice: number | null;
  image: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  inventoryQty: number | null; // null — если недоступно текущими scopes
  available: boolean; // статус доступности
  position: number | null;
  adminUrl: string | null; // ссылка на вариант в Admin, если есть
};

export type NormalizedProduct = {
  externalId: string; // id товара во внешней системе
  name: string;
  image: string | null;
  status: NormalizedProductStatus;
  productType: string | null;
  adminUrl: string | null; // ссылка на товар в Admin
  variants: NormalizedVariant[];
};

/** Источник каталога (Shopify / WooCommerce). */
export interface CatalogAdapter {
  platform: "WOOCOMMERCE" | "SHOPIFY";
  /** Всего товаров, если внешний API умеет это отдать (для прогресса «X из Y»). null — неизвестно. */
  countProducts(site: CatalogSite): Promise<number | null>;
  /** Постранично отдаёт нормализованные товары со ВСЕМИ вариантами. */
  fetchProducts(site: CatalogSite): AsyncGenerator<NormalizedProduct, void, unknown>;
}
