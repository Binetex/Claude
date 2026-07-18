import "server-only";
/**
 * ЕДИНЫЙ resolver Shopify-credentials для Site. Ни один адаптер не решает сам, откуда брать
 * token — все идут сюда.
 *
 * - CUSTOM_APP: access token — через tokenManager (mint/refresh 24ч); webhookSecret — Client
 *   Secret этого приложения (расшифровывается только на сервере).
 * - LEGACY (общий OAuth-app): stored `shopifyAccessToken`; webhookSecret — глобальный
 *   SHOPIFY_CLIENT_SECRET. Credentials режимов НЕ смешиваются.
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/secretBox";
import { getValidAccessToken } from "./tokenManager";
import { DEFAULT_SHOPIFY_API_VERSION } from "./config";

export type ShopifyCredentialMode = "CUSTOM_APP" | "LEGACY_OAUTH";

export type ResolvedShopifyCredentials = {
  siteId: string;
  authMode: ShopifyCredentialMode;
  shopDomain: string;
  apiVersion: string;
  accessToken: string;
  /** ТОЛЬКО для проверки webhook-подписи. Не использовать для Admin API запросов. */
  webhookSecret: string | null;
};

export class ShopifyCredentialsError extends Error {
  constructor(public readonly siteId: string, message: string) {
    super(message);
    this.name = "ShopifyCredentialsError";
  }
}

/** Возвращает готовые к использованию credentials Site (token уже валиден/обновлён). */
export async function resolveShopifyCredentials(siteId: string): Promise<ResolvedShopifyCredentials> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      authMode: true,
      platform: true,
      normalizedShopDomain: true,
      apiVersion: true,
      clientSecretEncrypted: true,
      shopifyShopDomain: true,
      shopifyAccessToken: true,
    },
  });
  if (!site) throw new ShopifyCredentialsError(siteId, "Site не найден");
  if (site.platform !== "SHOPIFY") throw new ShopifyCredentialsError(siteId, "Site не Shopify");

  if (site.authMode === "CUSTOM_APP") {
    if (!site.normalizedShopDomain) throw new ShopifyCredentialsError(siteId, "CUSTOM_APP без домена");
    // token через единый tokenManager (single-flight, 24h refresh)
    const accessToken = await getValidAccessToken(siteId);
    return {
      siteId,
      authMode: "CUSTOM_APP",
      shopDomain: site.normalizedShopDomain,
      apiVersion: site.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION,
      accessToken,
      webhookSecret: site.clientSecretEncrypted ? decryptSecret(site.clientSecretEncrypted) : null,
    };
  }

  // LEGACY общий OAuth-app.
  if (!site.shopifyShopDomain || !site.shopifyAccessToken) {
    throw new ShopifyCredentialsError(siteId, "Legacy Site без домена/токена");
  }
  return {
    siteId,
    authMode: "LEGACY_OAUTH",
    shopDomain: site.shopifyShopDomain,
    apiVersion: DEFAULT_SHOPIFY_API_VERSION,
    accessToken: site.shopifyAccessToken,
    webhookSecret: process.env.SHOPIFY_CLIENT_SECRET ?? null,
  };
}

/** Только access token (частый случай для адаптеров). */
export async function resolveShopifyAccessToken(siteId: string): Promise<{ shopDomain: string; apiVersion: string; accessToken: string }> {
  const c = await resolveShopifyCredentials(siteId);
  return { shopDomain: c.shopDomain, apiVersion: c.apiVersion, accessToken: c.accessToken };
}
