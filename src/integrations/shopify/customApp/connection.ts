import "server-only";
/**
 * Проверка подключения Custom App: получить/обновить токен → запросить фактический
 * shop{name,myshopifyDomain} и currentAppInstallation.accessScopes → сверить домен и scopes →
 * записать статус в Site. Фактические scopes берутся ИЗ Shopify (не из формы).
 */
import { prisma } from "@/lib/db";
import { shopifyAdminGraphQL, ShopifyReauthRequiredError } from "./client";
import { deriveConnectionResult, type ConnectionResult } from "./connectionLogic";
import { ShopifyAuthError } from "./tokenClient";

const CHECK_QUERY = `{
  shop { name myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;

type CheckData = {
  shop: { name: string; myshopifyDomain: string };
  currentAppInstallation: { accessScopes: { handle: string }[] };
};

/**
 * Выполняет проверку подключения и обновляет Site. Возвращает результат для UI.
 * НЕ бросает при REAUTH/auth-ошибке — возвращает результат со статусом REAUTH_REQUIRED.
 */
export async function checkConnection(siteId: string): Promise<ConnectionResult> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { normalizedShopDomain: true },
  });
  if (!site?.normalizedShopDomain) {
    return failResult("Site без домена — сначала введите credentials.");
  }

  let data: CheckData;
  try {
    data = await shopifyAdminGraphQL<CheckData>(siteId, CHECK_QUERY);
  } catch (err) {
    const reauth = err instanceof ShopifyReauthRequiredError || (err instanceof ShopifyAuthError && err.requiresReauth);
    const status = reauth ? "REAUTH_REQUIRED" : "CONNECTING";
    const message = reauth
      ? "Credentials больше не действуют. Обновите Client ID и Client Secret."
      : "Не удалось связаться с Shopify. Повторите проверку.";
    await prisma.site.update({
      where: { id: siteId },
      data: { shopifyConnStatus: status, connectionError: message, lastConnectionCheckAt: new Date() },
    });
    return { ...failResult(message), status };
  }

  const granted = data.currentAppInstallation.accessScopes.map((s) => s.handle);
  const result = deriveConnectionResult({
    enteredDomain: site.normalizedShopDomain,
    shop: { name: data.shop.name, myshopifyDomain: data.shop.myshopifyDomain },
    grantedScopes: granted,
  });

  await prisma.site.update({
    where: { id: siteId },
    data: {
      shopifyConnStatus: result.status,
      connectionStatus: result.ok ? "CONNECTED" : "PENDING",
      grantedScopes: result.grantedScopes,
      connectionError: result.error,
      lastConnectionCheckAt: new Date(),
      // timezone из Shopify API НЕ берём — Site.timezone задаётся владельцем вручную в карточке.
    },
  });

  return result;
}

function failResult(error: string): ConnectionResult {
  return {
    status: "REAUTH_REQUIRED",
    ok: false,
    domainMatches: false,
    shopName: null,
    myshopifyDomain: null,
    grantedScopes: [],
    missingScopes: [],
    canSyncProducts: false,
    canSyncOrders: false,
    error,
  };
}
