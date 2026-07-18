import "server-only";
/**
 * Реальные обработчики Shopify webhook-топиков (server-only). Инъектируются в
 * buildShopifyWebhookHandler. Ключевое:
 *  - заказы: единый нормализатор (ingestShopifyOrder) + защита от out-of-order/откатов;
 *  - товары: upsert БЕЗ перезаписи локальных floristPrice/composition; delete → remoteDeleted;
 *  - app/uninstalled: REAUTH_REQUIRED, sync стоп, НИЧЕГО не удаляем.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { ProductStatus } from "@/generated/prisma/enums";
import { ingestShopifyOrder, type ShopifyOrder } from "@/integrations/shopify/ingestOrder";
import { isStaleUpdate, isForbiddenStatusTransition } from "./webhookVerifyLogic";
import type { ShopifyWebhookHandlerDeps } from "./webhookHandler";

const TERMINAL = new Set(["CANCELLED", "DELIVERED"]);

/** Приём заказа из webhook с защитой от устаревших событий и откатов терминальных статусов. */
async function ingestOrder(siteId: string, topic: string, shopify: unknown): Promise<void> {
  const payload = shopify as ShopifyOrder;
  const externalId = String(payload.id);
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { shopifyShopDomain: true, normalizedShopDomain: true } });
  const shopDomain = site?.shopifyShopDomain ?? site?.normalizedShopDomain;
  if (!shopDomain) return;

  const existing = await prisma.order.findFirst({
    where: { siteId, externalId },
    select: { orderStatus: true, externalUpdatedAt: true },
  });

  if (existing) {
    // 1) Устаревшее событие (по updated_at) не применяем.
    const incomingUpdatedAt = payload.updated_at ? new Date(payload.updated_at) : null;
    if (isStaleUpdate(incomingUpdatedAt, existing.externalUpdatedAt)) return;
    // 2) Не откатываем терминальный статус ранним рабочим (кроме явного cancelled-события).
    if (topic !== "orders/cancelled" && TERMINAL.has(existing.orderStatus)) return;
  }

  await ingestShopifyOrder(topic.replace("orders/", "orders/"), shopDomain, payload);

  // Фиксируем externalUpdatedAt (ingest create уже проставляет; для update-пути — здесь).
  if (payload.updated_at) {
    await prisma.order.updateMany({
      where: { siteId, externalId },
      data: { externalUpdatedAt: new Date(payload.updated_at) },
    });
  }
}

/** refunds/create → отметить оплату REFUNDED (внутренний рабочий статус не откатываем). */
async function applyRefund(siteId: string, shopify: unknown): Promise<void> {
  const p = shopify as { order_id?: number | string };
  if (p.order_id == null) return;
  await prisma.order.updateMany({
    where: { siteId, externalId: String(p.order_id) },
    data: { paymentStatus: "REFUNDED" },
  });
}

type ShopifyProductWebhook = {
  id: number | string;
  title?: string;
  status?: string;
  image?: { src?: string } | null;
  variants?: { id: number | string; title?: string; sku?: string | null; price?: string | null }[];
};

function mapProductStatus(s: string | undefined): ProductStatus {
  if (s === "draft") return "DRAFT";
  if (s === "archived") return "ARCHIVED";
  return "ACTIVE";
}

/** products/create|update → upsert. НЕ трогаем floristPrice/defaultFloristComposition/floristComposition. */
async function upsertProduct(siteId: string, shopify: unknown): Promise<void> {
  const p = shopify as ShopifyProductWebhook;
  const externalId = String(p.id);
  const common = {
    name: p.title ?? "—",
    status: mapProductStatus(p.status),
    image: p.image?.src ?? null,
    remoteDeleted: false,
    deletedAt: null,
    lastSyncedAt: new Date(),
  };
  const product = await prisma.product.upsert({
    where: { siteId_externalId: { siteId, externalId } },
    update: common, // локальные floristPrice/defaultFloristComposition НЕ в common → сохраняются
    create: { siteId, externalId, ...common },
    select: { id: true },
  });
  for (const v of p.variants ?? []) {
    const vCommon = {
      title: v.title ?? "Default Title",
      sku: v.sku ?? null,
      listPrice: new Prisma.Decimal(v.price && v.price.length ? v.price : "0"),
      remoteDeleted: false,
      deletedAt: null,
      lastSyncedAt: new Date(),
    };
    await prisma.productVariant.upsert({
      where: { productId_externalId: { productId: product.id, externalId: String(v.id) } },
      update: vCommon, // floristPrice/floristComposition варианта НЕ трогаем
      create: { productId: product.id, externalId: String(v.id), available: true, ...vCommon },
    });
  }
}

/** products/delete → remoteDeleted=true (физически НЕ удаляем; локальные поля сохраняются). */
async function markProductDeleted(siteId: string, shopify: unknown): Promise<void> {
  const p = shopify as { id?: number | string };
  if (p.id == null) return;
  const now = new Date();
  await prisma.product.updateMany({ where: { siteId, externalId: String(p.id), remoteDeleted: false }, data: { remoteDeleted: true, deletedAt: now } });
  await prisma.productVariant.updateMany({ where: { product: { siteId, externalId: String(p.id) }, remoteDeleted: false }, data: { remoteDeleted: true, deletedAt: now } });
}

/** app/uninstalled → доступ потерян: REAUTH_REQUIRED, sync стоп, БЕЗ удаления данных. */
async function handleAppUninstalled(siteId: string): Promise<void> {
  await prisma.site.update({
    where: { id: siteId },
    data: {
      shopifyConnStatus: "REAUTH_REQUIRED",
      connectionStatus: "DISCONNECTED",
      accessTokenEncrypted: null,
      accessTokenMask: null,
      accessTokenExpiresAt: null,
      connectionError: "Приложение удалено из магазина. Переустановите и обновите credentials. История и товары сохранены.",
    },
  });
}

/** app/scopes_update → перепроверить фактические scopes. */
async function handleScopesUpdate(siteId: string): Promise<void> {
  const { checkConnection } = await import("./connection");
  await checkConnection(siteId);
}

/** Готовый набор реальных обработчиков для worker'а. */
export const shopifyWebhookHandlerDeps: ShopifyWebhookHandlerDeps = {
  ingestOrder,
  applyRefund,
  upsertProduct,
  markProductDeleted,
  handleAppUninstalled,
  handleScopesUpdate,
};
