/**
 * Чистая логика вывода статуса подключения Custom App из результатов Shopify API.
 * Отделена от БД/сети — полностью тестируема. Сервер-обёртка (`connection.ts`) вызывает её.
 */
import { normalizeMyshopifyDomain } from "./domain";
import { diffScopes } from "./scopes";

export type ShopifyConnStatus = "CONNECTING" | "CONNECTED" | "DEGRADED" | "REAUTH_REQUIRED" | "DISCONNECTED";

export type ShopInfo = { name: string; myshopifyDomain: string };

export type ConnectionResult = {
  status: ShopifyConnStatus;
  /** Подключение можно считать рабочим (домен совпал, токен есть). */
  ok: boolean;
  domainMatches: boolean;
  shopName: string | null;
  myshopifyDomain: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  canSyncProducts: boolean;
  canSyncOrders: boolean;
  error: string | null;
};

/**
 * Выводит итог проверки подключения.
 * - Домен из ответа Shopify (`shop.myshopifyDomain`) ДОЛЖЕН совпасть с введённым — иначе
 *   credentials принадлежат другому магазину, подключение НЕ активируем (REAUTH_REQUIRED).
 * - Все обязательные scopes → CONNECTED; часть отсутствует → DEGRADED (частичный доступ).
 */
export function deriveConnectionResult(params: {
  enteredDomain: string; // нормализованный введённый домен
  shop: ShopInfo;
  grantedScopes: string[];
}): ConnectionResult {
  const actual = normalizeMyshopifyDomain(params.shop.myshopifyDomain);
  const entered = normalizeMyshopifyDomain(params.enteredDomain);
  const domainMatches = actual === entered;

  const { granted, missing, hasAll } = diffScopes(params.grantedScopes);
  const canSyncProducts = granted.includes("read_products");
  const canSyncOrders = granted.includes("read_orders");

  if (!domainMatches) {
    return {
      status: "REAUTH_REQUIRED",
      ok: false,
      domainMatches: false,
      shopName: params.shop.name,
      myshopifyDomain: params.shop.myshopifyDomain,
      grantedScopes: granted,
      missingScopes: missing,
      canSyncProducts: false,
      canSyncOrders: false,
      error: `Credentials принадлежат другому магазину: Shopify вернул ${actual}, а введён ${entered}.`,
    };
  }

  return {
    status: hasAll ? "CONNECTED" : "DEGRADED",
    ok: true,
    domainMatches: true,
    shopName: params.shop.name,
    myshopifyDomain: params.shop.myshopifyDomain,
    grantedScopes: granted,
    missingScopes: missing,
    canSyncProducts,
    canSyncOrders,
    error: hasAll ? null : `Не хватает обязательных scopes: ${missing.join(", ")}.`,
  };
}
