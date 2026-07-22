/**
 * Интеграционные тесты Shopify Custom App против ЛОКАЛЬНОЙ тестовой БД.
 * Запуск: DATABASE_URL=<local> CREDENTIALS_ENCRYPTION_KEY=<b64-32> npx vitest run <this>
 * НЕ использует production БД и НЕ ходит в реальный Shopify.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto/secretBox";
import { resolveShopifyCredentials } from "./credentials";
import { shopifyWebhookHandlerDeps } from "./webhookHandlerDeps";
import { findSiteByDomain } from "./management";

// без "_" — домены myshopify не содержат подчёркиваний (см. строгую валидацию домена).
const RUN = `itest${Date.now()}`;
const dom = (n: string) => `${RUN}-${n}.myshopify.com`;

async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { order: { site: { shortName: RUN } } } });
  await prisma.order.deleteMany({ where: { site: { shortName: RUN } } });
  await prisma.productVariant.deleteMany({ where: { product: { site: { shortName: RUN } } } });
  await prisma.product.deleteMany({ where: { site: { shortName: RUN } } });
  await prisma.shopifyWebhook.deleteMany({ where: { site: { shortName: RUN } } });
  await prisma.site.deleteMany({ where: { shortName: RUN } });
}

async function makeCustomAppSite(name: string) {
  return prisma.site.create({
    data: {
      name, shortName: RUN, platform: "SHOPIFY", connectionStatus: "PENDING",
      authMode: "CUSTOM_APP", normalizedShopDomain: dom(name), shopifyShopDomain: dom(name),
      clientIdEncrypted: encryptSecret("cid"), clientSecretEncrypted: encryptSecret("csecret"),
      accessTokenEncrypted: encryptSecret("shpat_tok"), accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      shopifyConnStatus: "CONNECTED", apiVersion: "2026-07",
    },
    select: { id: true },
  });
}

beforeAll(cleanup);
afterAll(cleanup);

describe("resolver — legacy vs custom app", () => {
  it("legacy Site → LEGACY_OAUTH со stored token", async () => {
    const site = await prisma.site.create({
      data: { name: "Legacy", shortName: RUN, platform: "SHOPIFY", connectionStatus: "CONNECTED", shopifyShopDomain: dom("legacy"), shopifyAccessToken: "shpat_legacy" },
      select: { id: true },
    });
    const c = await resolveShopifyCredentials(site.id);
    expect(c.authMode).toBe("LEGACY_OAUTH");
    expect(c.accessToken).toBe("shpat_legacy");
    expect(c.shopDomain).toBe(dom("legacy"));
  });

  it("custom app Site → CUSTOM_APP, token расшифрован (валидный, без mint)", async () => {
    const site = await makeCustomAppSite("ca");
    const c = await resolveShopifyCredentials(site.id);
    expect(c.authMode).toBe("CUSTOM_APP");
    expect(c.accessToken).toBe("shpat_tok"); // токен ещё валиден → берётся из БД, mint не нужен
    expect(c.webhookSecret).toBe("csecret");
  });
});

describe("disconnect — сохраняет данные, чистит credentials", () => {
  it("товары остаются, credentials обнулены, статус DISCONNECTED", async () => {
    const site = await makeCustomAppSite("disc");
    await prisma.product.create({ data: { siteId: site.id, externalId: "p1", name: "Rose", floristPrice: new Prisma.Decimal(70) } });

    const { disconnectSite } = await import("./management");
    await disconnectSite(site.id);

    const after = await prisma.site.findUnique({ where: { id: site.id }, select: { shopifyConnStatus: true, clientSecretEncrypted: true, accessTokenEncrypted: true } });
    expect(after?.shopifyConnStatus).toBe("DISCONNECTED");
    expect(after?.clientSecretEncrypted).toBeNull();
    expect(after?.accessTokenEncrypted).toBeNull();
    const products = await prisma.product.findMany({ where: { siteId: site.id } });
    expect(products).toHaveLength(1); // товар сохранён
    expect(products[0].floristPrice?.toString()).toBe("70");
  });
});

describe("app/uninstalled — не удаляет историю", () => {
  it("REAUTH_REQUIRED + токен null + товары остаются", async () => {
    const site = await makeCustomAppSite("uninst");
    await prisma.product.create({ data: { siteId: site.id, externalId: "p1", name: "Tulip" } });
    await shopifyWebhookHandlerDeps.handleAppUninstalled(site.id);
    const after = await prisma.site.findUnique({ where: { id: site.id }, select: { shopifyConnStatus: true, accessTokenEncrypted: true } });
    expect(after?.shopifyConnStatus).toBe("REAUTH_REQUIRED");
    expect(after?.accessTokenEncrypted).toBeNull();
    expect(await prisma.product.count({ where: { siteId: site.id } })).toBe(1);
  });
});

describe("product upsert из webhook — сохраняет локальные поля", () => {
  it("floristPrice/composition не перезаписываются, внешние данные обновляются", async () => {
    const site = await makeCustomAppSite("prod");
    const p = await prisma.product.create({
      data: { siteId: site.id, externalId: "555", name: "Old name", floristPrice: new Prisma.Decimal(42), defaultFloristComposition: "12 roses" },
      select: { id: true },
    });
    await prisma.productVariant.create({ data: { productId: p.id, externalId: "999", title: "S", listPrice: new Prisma.Decimal(10), floristComposition: "local comp" } });

    await shopifyWebhookHandlerDeps.upsertProduct(site.id, {
      id: 555, title: "New name", status: "active",
      variants: [{ id: 999, title: "S", price: "15.00" }],
    });

    const prod = await prisma.product.findFirst({ where: { siteId: site.id, externalId: "555" } });
    expect(prod?.name).toBe("New name"); // внешнее обновлено
    expect(prod?.floristPrice?.toString()).toBe("42"); // локальное сохранено
    expect(prod?.defaultFloristComposition).toBe("12 roses");
    const v = await prisma.productVariant.findFirst({ where: { productId: p.id, externalId: "999" } });
    expect(v?.listPrice.toString()).toBe("15"); // внешняя цена обновлена
    expect(v?.floristComposition).toBe("local comp"); // локальный состав сохранён
  });

  it("products/delete → remoteDeleted=true (физически не удалён)", async () => {
    const site = await makeCustomAppSite("del");
    await prisma.product.create({ data: { siteId: site.id, externalId: "del1", name: "X" } });
    await shopifyWebhookHandlerDeps.markProductDeleted(site.id, { id: "del1" });
    const prod = await prisma.product.findFirst({ where: { siteId: site.id, externalId: "del1" } });
    expect(prod?.remoteDeleted).toBe(true);
    expect(prod).not.toBeNull(); // не удалён физически
  });
});

describe("reconnect — существующий Site, без дубля", () => {
  it("findSiteByDomain находит существующий; unique запрещает второй активный", async () => {
    const site = await makeCustomAppSite("recon");
    const found = await findSiteByDomain(dom("recon"));
    expect(found?.id).toBe(site.id);

    // Прямой второй create того же (platform, normalizedShopDomain) → нарушение unique.
    await expect(
      prisma.site.create({ data: { name: "dup", shortName: RUN, platform: "SHOPIFY", connectionStatus: "PENDING", authMode: "CUSTOM_APP", normalizedShopDomain: dom("recon") } })
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("out-of-order — устаревший webhook не применяется", () => {
  it("orders/updated старше сохранённого не трогает заказ", async () => {
    const site = await makeCustomAppSite("ooo");
    const T2 = new Date("2026-07-18T12:00:00Z");
    await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1001`, siteId: site.id, source: "Shopify", platform: "SHOPIFY",
        externalId: "7001", externalCreatedAt: T2, externalUpdatedAt: T2,
        deliveryDate: T2, deliveryWindow: "12-16",
        senderName: "S", senderPhone: "+1", recipientName: "R", recipientPhone: "+2",
        addressLine: "1 st", city: "LA", zip: "90001",
        itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(108),
        orderStatus: "CONFIRMED",
      },
    });
    // старое событие (updated_at раньше T2)
    await shopifyWebhookHandlerDeps.ingestOrder(site.id, "orders/updated", { id: 7001, updated_at: "2026-07-18T10:00:00Z" });
    const after = await prisma.order.findFirst({ where: { siteId: site.id, externalId: "7001" }, select: { externalUpdatedAt: true, orderStatus: true } });
    expect(after?.externalUpdatedAt?.toISOString()).toBe(T2.toISOString()); // не откатилось
    expect(after?.orderStatus).toBe("CONFIRMED");
  });
});
