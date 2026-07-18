import "server-only";
/**
 * Единый Admin GraphQL клиент Shopify Custom App. Credentials/токен ВСЕГДА берутся из
 * конкретного Site (никаких глобальных SHOPIFY_* для CUSTOM_APP). При 401 — ровно один
 * refresh токена и один повтор; при повторном 401 — Site → REAUTH_REQUIRED и ошибка.
 */
import { prisma } from "@/lib/db";
import { getValidAccessToken } from "./tokenManager";

export const DEFAULT_SHOPIFY_API_VERSION = "2026-07";

export class ShopifyReauthRequiredError extends Error {
  constructor(public readonly siteId: string) {
    super("Shopify credentials больше не действуют (REAUTH_REQUIRED).");
    this.name = "ShopifyReauthRequiredError";
  }
}

type GraphQLResponse<T> = { data?: T; errors?: unknown };

/** Выполняет Admin GraphQL запрос от имени Site. */
export async function shopifyAdminGraphQL<T = unknown>(
  siteId: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { normalizedShopDomain: true, apiVersion: true },
  });
  if (!site?.normalizedShopDomain) throw new Error("Site не сконфигурирован (нет домена).");
  const apiVersion = site.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION;
  const url = `https://${site.normalizedShopDomain}/admin/api/${apiVersion}/graphql.json`;

  const call = async (token: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });

  let res = await call(await getValidAccessToken(siteId));
  if (res.status === 401) {
    // один refresh + один повтор
    res = await call(await getValidAccessToken(siteId, { forceRefresh: true }));
    if (res.status === 401) {
      await prisma.site.update({
        where: { id: siteId },
        data: { shopifyConnStatus: "REAUTH_REQUIRED", connectionError: "Credentials больше не действуют. Обновите Client ID и Client Secret." },
      });
      throw new ShopifyReauthRequiredError(siteId);
    }
  }
  if (!res.ok) throw new Error(`Shopify Admin GraphQL HTTP ${res.status}`);

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors) {
    // не логируем токен/секреты; ошибки GraphQL усечены
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data as T;
}
