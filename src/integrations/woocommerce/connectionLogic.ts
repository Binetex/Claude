/**
 * Чистая деривация результата проверки подключения WooCommerce из результатов проб.
 * Без сети/БД — тестируема. Правило: подключение считается рабочим, только если доступны
 * ключевые read-эндпоинты (products и orders). system_status — необязательная диагностика
 * (некоторые роли к нему не имеют доступа, поэтому его недоступность НЕ проваливает проверку).
 */
import type { WooConnStatus } from "@/generated/prisma/enums";
import type { WooErrorKind } from "./clientErrors";

export type WooProbe =
  | { ok: true }
  | { ok: false; kind: WooErrorKind; message: string };

export type WooStoreInfo = {
  storeName: string | null;
  currency: string | null;
  // timezone НЕ храним: WooCommerce REST её не отдаёт (system_status.settings без timezone,
  // /wp/v2/settings → 401 с Consumer Key), а в логике Floremart она не участвует.
  wooVersion: string | null;
  wpVersion: string | null;
};

export type WooProbeSet = {
  products: WooProbe; // GET /products?per_page=1
  orders: WooProbe; // GET /orders?per_page=1
  webhooks: WooProbe; // GET /webhooks?per_page=1 — право управлять вебхуками
  store: WooStoreInfo | null; // из /system_status, если доступен
};

export type WooConnectionResult = {
  ok: boolean;
  status: WooConnStatus;
  error: string | null;
  capabilities: {
    readProducts: boolean;
    readOrders: boolean;
    manageWebhooks: boolean;
  };
  store: WooStoreInfo | null;
};

/** true, если ошибка пробы означает недействительные credentials (повторная авторизация). */
function isAuthKind(p: WooProbe): boolean {
  return !p.ok && (p.kind === "auth" || p.kind === "forbidden");
}

export function deriveWooConnection(probes: WooProbeSet): WooConnectionResult {
  const readProducts = probes.products.ok;
  const readOrders = probes.orders.ok;
  const manageWebhooks = probes.webhooks.ok;

  const capabilities = { readProducts, readOrders, manageWebhooks };

  // Оба ключевых read-эндпоинта отвалились по auth/forbidden → credentials недействительны.
  if (!readProducts && !readOrders && (isAuthKind(probes.products) || isAuthKind(probes.orders))) {
    const msg =
      (!probes.products.ok && probes.products.message) ||
      (!probes.orders.ok && probes.orders.message) ||
      "Не удалось авторизоваться в WooCommerce REST API.";
    return { ok: false, status: "REAUTH_REQUIRED", error: msg, capabilities, store: probes.store };
  }

  // Полный доступ к товарам и заказам — подключение рабочее.
  if (readProducts && readOrders) {
    // Нет права на вебхуки — подключено, но с ограничением (webhooks не зарегистрируем).
    if (!manageWebhooks) {
      return {
        ok: true,
        status: "DEGRADED",
        error: "Товары и заказы доступны, но нет прав на управление вебхуками (нужен доступ manage_woocommerce у пользователя ключа). Реального времени по заказам не будет — используйте ручную синхронизацию.",
        capabilities,
        store: probes.store,
      };
    }
    return { ok: true, status: "CONNECTED", error: null, capabilities, store: probes.store };
  }

  // Частичный доступ (один из ключевых эндпоинтов недоступен) — DEGRADED с пояснением.
  const failing = !readProducts ? probes.products : probes.orders;
  const reason = !failing.ok ? failing.message : "Часть эндпоинтов WooCommerce недоступна.";
  return { ok: false, status: "DEGRADED", error: reason, capabilities, store: probes.store };
}
