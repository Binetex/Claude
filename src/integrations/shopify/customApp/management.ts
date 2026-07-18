import "server-only";
/**
 * Управление подключением Shopify Custom App: connect/reconnect, disconnect, поиск по домену.
 *
 * - Credentials шифруются (AES-256-GCM) перед сохранением; маски — для UI без расшифровки.
 * - Повторное подключение того же нормализованного домена ВОССТАНАВЛИВАЕТ существующий Site
 *   (не создаёт новый) — товары/варианты/заказы/локальные настройки сохраняются.
 * - Disconnect не удаляет Site и историю; лишь очищает credentials и деактивирует webhooks.
 */
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret } from "@/lib/crypto/secretBox";
import { parseMyshopifyDomain } from "./domain";
import { checkConnection } from "./connection";
import { DEFAULT_SHOPIFY_API_VERSION } from "./client";
import type { ConnectionResult } from "./connectionLogic";

export type ConnectInput = {
  name: string;
  domain: string; // сырой ввод владельца
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
};

export type ConnectOutcome =
  | { ok: false; error: string }
  | { ok: true; siteId: string; reconnected: boolean; result: ConnectionResult };

function shortNameFrom(name: string): string {
  return name.trim().slice(0, 12).toUpperCase().replace(/\s+/g, "") || "SHOP";
}

/** Существующий Site по нормализованному домену — для UI-подтверждения восстановления. */
export async function findSiteByDomain(domainInput: string) {
  const parsed = parseMyshopifyDomain(domainInput);
  if (!parsed.ok) return null;
  return prisma.site.findFirst({
    where: { platform: "SHOPIFY", normalizedShopDomain: parsed.domain },
    select: { id: true, name: true, shopifyConnStatus: true, normalizedShopDomain: true },
  });
}

/**
 * Подключает/переподключает магазин. Идемпотентно по домену: один Site на (SHOPIFY, домен).
 * `allowReconnect` — подтверждение владельца на восстановление существующего Site.
 */
export async function connectCustomApp(input: ConnectInput, opts: { allowReconnect?: boolean } = {}): Promise<ConnectOutcome> {
  const parsed = parseMyshopifyDomain(input.domain);
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  const domain = parsed.domain;

  if (!input.clientId.trim() || !input.clientSecret.trim()) {
    return { ok: false, error: "Укажите Client ID и Client Secret." };
  }

  const existing = await prisma.site.findFirst({
    where: { platform: "SHOPIFY", normalizedShopDomain: domain },
    select: { id: true, shopifyConnStatus: true },
  });

  if (existing && existing.shopifyConnStatus === "CONNECTED" && !opts.allowReconnect) {
    return { ok: false, error: "Этот магазин уже подключён. Для смены credentials используйте «Обновить credentials»." };
  }

  const creds = {
    authMode: "CUSTOM_APP" as const,
    normalizedShopDomain: domain,
    shopifyShopDomain: domain,
    clientIdEncrypted: encryptSecret(input.clientId.trim()),
    clientSecretEncrypted: encryptSecret(input.clientSecret.trim()),
    clientSecretMask: maskSecret(input.clientSecret.trim()),
    apiVersion: input.apiVersion?.trim() || DEFAULT_SHOPIFY_API_VERSION,
    shopifyConnStatus: "CONNECTING" as const,
    connectionError: null,
    // сбрасываем прежний токен — будет намитен заново на актуальные credentials
    accessTokenEncrypted: null,
    accessTokenMask: null,
    accessTokenExpiresAt: null,
  };

  let siteId: string;
  let reconnected = false;
  if (existing) {
    await prisma.site.update({ where: { id: existing.id }, data: creds });
    siteId = existing.id;
    reconnected = true;
  } else {
    const site = await prisma.site.create({
      data: {
        name: input.name.trim() || domain,
        shortName: shortNameFrom(input.name || domain),
        platform: "SHOPIFY",
        connectionStatus: "PENDING",
        ...creds,
      },
      select: { id: true },
    });
    siteId = site.id;
  }

  // Первичная проверка: минтит токен, сверяет домен и scopes, ставит статус.
  const result = await checkConnection(siteId);
  return { ok: true, siteId, reconnected, result };
}

/** Обновление только credentials существующего Site (без создания нового). */
export async function updateCustomAppCredentials(
  siteId: string,
  input: { clientId: string; clientSecret: string; apiVersion?: string }
): Promise<ConnectionResult> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { clientSecretEncrypted: true } });
  if (!site) throw new Error("Site не найден");

  await prisma.site.update({
    where: { id: siteId },
    data: {
      // окно ротации: старый secret валиден для входящих webhook ещё 48ч
      previousClientSecretEncrypted: site.clientSecretEncrypted,
      previousSecretValidUntil: new Date(Date.now() + 48 * 3600 * 1000),
      clientIdEncrypted: encryptSecret(input.clientId.trim()),
      clientSecretEncrypted: encryptSecret(input.clientSecret.trim()),
      clientSecretMask: maskSecret(input.clientSecret.trim()),
      ...(input.apiVersion?.trim() ? { apiVersion: input.apiVersion.trim() } : {}),
      accessTokenEncrypted: null,
      accessTokenMask: null,
      accessTokenExpiresAt: null,
      shopifyConnStatus: "CONNECTING",
      connectionError: null,
    },
  });
  return checkConnection(siteId);
}

/**
 * Безопасное отключение: DISCONNECTED, очистка credentials/токена, деактивация webhooks.
 * Товары/варианты/заказы и локальные настройки НЕ удаляются. Site НЕ удаляется.
 */
export async function disconnectSite(siteId: string): Promise<void> {
  await prisma.$transaction([
    prisma.shopifyWebhook.updateMany({ where: { siteId }, data: { status: "DELETED" } }),
    prisma.site.update({
      where: { id: siteId },
      data: {
        shopifyConnStatus: "DISCONNECTED",
        connectionStatus: "DISCONNECTED",
        clientIdEncrypted: null,
        clientSecretEncrypted: null,
        clientSecretMask: null,
        previousClientSecretEncrypted: null,
        previousSecretValidUntil: null,
        accessTokenEncrypted: null,
        accessTokenMask: null,
        accessTokenExpiresAt: null,
        connectionError: null,
        // normalizedShopDomain сохраняем — по нему находим Site при повторном подключении.
      },
    }),
  ]);
  // Реальный вызов Shopify (удаление webhook-подписок / revoke токена) — best-effort в
  // webhookRegistration.deleteAllWebhooks(siteId); здесь не делаем сетевой вызов обязательным,
  // чтобы отключение не падало из-за недоступности Shopify.
}
