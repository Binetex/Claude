import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { AirwallexClient, type AirwallexCreds, type AirwallexEnv } from "./client";

/**
 * Пер-сайтовые настройки Airwallex Payment Monitoring. Всё живёт на WooCommerceConnection.
 *
 * Правила безопасности (как у Shopify/QUO/Telegram):
 *  - Client ID и API Key хранятся ТОЛЬКО зашифрованными; наружу отдаётся лишь маска ключа;
 *  - пустое поле при сохранении НЕ стирает существующее значение;
 *  - изменение любого credential сбрасывает проверку и выключает мониторинг;
 *  - включить мониторинг можно лишь после успешного Verify (airwallexApiVerifiedAt).
 */
export type AirwallexSettingsView = {
  monitoringEnabled: boolean;
  clientIdConfigured: boolean;
  apiKeyConfigured: boolean;
  apiKeyMask: string | null;
  env: AirwallexEnv;
  pendingThresholdMin: number;
  verifiedAt: string | null;
  connStatus: string | null;
  errorSafe: string | null;
  cryptoConfigured: boolean;
};

export async function loadAirwallexSettings(prisma: PrismaClient, siteId: string): Promise<AirwallexSettingsView | null> {
  const c = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: {
      airwallexMonitoringEnabled: true, airwallexApiClientIdEncrypted: true, airwallexApiKeyEncrypted: true,
      airwallexApiKeyMask: true, airwallexApiEnv: true, airwallexPendingThresholdMin: true,
      airwallexApiVerifiedAt: true, airwallexApiConnStatus: true, airwallexApiErrorSafe: true,
    },
  });
  if (!c) return null;
  return {
    monitoringEnabled: c.airwallexMonitoringEnabled,
    clientIdConfigured: !!c.airwallexApiClientIdEncrypted,
    apiKeyConfigured: !!c.airwallexApiKeyEncrypted,
    apiKeyMask: c.airwallexApiKeyMask,
    env: c.airwallexApiEnv === "demo" ? "demo" : "prod",
    pendingThresholdMin: c.airwallexPendingThresholdMin,
    verifiedAt: c.airwallexApiVerifiedAt ? c.airwallexApiVerifiedAt.toISOString() : null,
    connStatus: c.airwallexApiConnStatus,
    errorSafe: c.airwallexApiErrorSafe,
    cryptoConfigured: isCredentialCryptoConfigured(),
  };
}

/** Расшифрованные credentials для сетевых вызовов. null — не настроено/повреждено. */
export async function resolveAirwallexCreds(prisma: PrismaClient, siteId: string): Promise<AirwallexCreds | null> {
  const c = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: { airwallexApiClientIdEncrypted: true, airwallexApiKeyEncrypted: true, airwallexApiEnv: true },
  });
  if (!c?.airwallexApiClientIdEncrypted || !c.airwallexApiKeyEncrypted) return null;
  try {
    return {
      clientId: decryptSecret(c.airwallexApiClientIdEncrypted),
      apiKey: decryptSecret(c.airwallexApiKeyEncrypted),
      env: c.airwallexApiEnv === "demo" ? "demo" : "prod",
    };
  } catch {
    return null; // сменился ключ шифрования — считаем ненастроенным, не падаем
  }
}

export type SaveInput = {
  clientId?: string; // пусто = не менять
  apiKey?: string; // пусто = не менять
  env?: AirwallexEnv;
  pendingThresholdMin?: number;
};

export async function saveAirwallexSettings(prisma: PrismaClient, siteId: string, input: SaveInput): Promise<{ ok: true } | { error: string }> {
  const cur = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: { airwallexApiClientIdEncrypted: true, airwallexApiKeyEncrypted: true, airwallexApiEnv: true },
  });
  if (!cur) return { error: "WooCommerce не подключён для этого сайта." };

  const clientId = input.clientId?.trim();
  const apiKey = input.apiKey?.trim();
  const env: AirwallexEnv = input.env === "demo" ? "demo" : "prod";
  const threshold = input.pendingThresholdMin != null ? Math.max(1, Math.floor(input.pendingThresholdMin)) : undefined;

  // Любое изменение credential/окружения делает прежнюю проверку недействительной.
  const credChanged = !!clientId || !!apiKey || env !== (cur.airwallexApiEnv === "demo" ? "demo" : "prod");

  await prisma.wooCommerceConnection.update({
    where: { siteId },
    data: {
      ...(clientId ? { airwallexApiClientIdEncrypted: encryptSecret(clientId) } : {}),
      ...(apiKey ? { airwallexApiKeyEncrypted: encryptSecret(apiKey), airwallexApiKeyMask: maskSecret(apiKey) } : {}),
      airwallexApiEnv: env,
      ...(threshold != null ? { airwallexPendingThresholdMin: threshold } : {}),
      ...(credChanged ? { airwallexApiVerifiedAt: null, airwallexMonitoringEnabled: false, airwallexApiConnStatus: null, airwallexApiErrorSafe: null } : {}),
    },
  });
  return { ok: true };
}

export type VerifyOutcome = { ok: boolean; message: string };

/** Проверка подключения: авторизация в Airwallex. Успех выставляет verifiedAt/статус. */
export async function verifyAirwallex(prisma: PrismaClient, siteId: string): Promise<VerifyOutcome> {
  const creds = await resolveAirwallexCreds(prisma, siteId);
  if (!creds) {
    await prisma.wooCommerceConnection.update({ where: { siteId }, data: { airwallexApiConnStatus: "error", airwallexApiErrorSafe: "Client ID и API Key не заданы.", airwallexApiVerifiedAt: null } }).catch(() => undefined);
    return { ok: false, message: "Client ID и API Key не заданы." };
  }
  const res = await new AirwallexClient(creds).verify();
  if (res.ok) {
    await prisma.wooCommerceConnection.update({ where: { siteId }, data: { airwallexApiVerifiedAt: new Date(), airwallexApiConnStatus: "ok", airwallexApiErrorSafe: null } });
    return { ok: true, message: "Подключение к Airwallex подтверждено." };
  }
  const message = res.code === "unauthorized" ? "Client ID или API Key недействительны." : res.code.startsWith("network") ? "Нет связи с Airwallex (таймаут/сеть)." : "Airwallex вернул ошибку.";
  await prisma.wooCommerceConnection.update({ where: { siteId }, data: { airwallexApiVerifiedAt: null, airwallexMonitoringEnabled: false, airwallexApiConnStatus: res.code === "unauthorized" ? "unauthorized" : "error", airwallexApiErrorSafe: message } });
  return { ok: false, message };
}

/** Включение мониторинга — только после успешного Verify. */
export async function setAirwallexMonitoring(prisma: PrismaClient, siteId: string, enabled: boolean): Promise<{ ok: true } | { error: string }> {
  const c = await prisma.wooCommerceConnection.findUnique({ where: { siteId }, select: { airwallexApiVerifiedAt: true } });
  if (!c) return { error: "WooCommerce не подключён." };
  if (enabled && !c.airwallexApiVerifiedAt) return { error: "Сначала выполните Verify — включить мониторинг без проверки нельзя." };
  await prisma.wooCommerceConnection.update({ where: { siteId }, data: { airwallexMonitoringEnabled: enabled } });
  return { ok: true };
}
