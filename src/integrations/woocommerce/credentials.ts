import "server-only";
/**
 * Резолвер credentials WooCommerce для Site. Секреты расшифровываются ТОЛЬКО здесь
 * (через общий lib/crypto/secretBox — второй механизм не заводим). Наружу (UI/логи)
 * расшифрованные значения не отдаём.
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/secretBox";

export type WooCredentials = {
  siteId: string;
  storeUrl: string;
  apiBaseUrl: string;
  apiVersion: string;
  consumerKey: string;
  consumerSecret: string;
};

export class WooNotConnectedError extends Error {
  constructor(message = "WooCommerce не подключён для этого сайта.") {
    super(message);
    this.name = "WooNotConnectedError";
  }
}

/** Полная запись подключения (без расшифровки секретов) — для connection/management-логики. */
export async function getWooConnection(siteId: string) {
  return prisma.wooCommerceConnection.findUnique({ where: { siteId } });
}

/** Расшифрованные credentials для сетевых вызовов. Бросает, если магазин не подключён. */
export async function resolveWooCredentials(siteId: string): Promise<WooCredentials> {
  const conn = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: {
      siteId: true,
      storeUrl: true,
      apiBaseUrl: true,
      apiVersion: true,
      consumerKeyEncrypted: true,
      consumerSecretEncrypted: true,
      connStatus: true,
    },
  });
  if (!conn || conn.connStatus === "DISCONNECTED") throw new WooNotConnectedError();
  return {
    siteId: conn.siteId,
    storeUrl: conn.storeUrl,
    apiBaseUrl: conn.apiBaseUrl,
    apiVersion: conn.apiVersion,
    consumerKey: decryptSecret(conn.consumerKeyEncrypted),
    consumerSecret: decryptSecret(conn.consumerSecretEncrypted),
  };
}

/** Расшифрованный webhook secret этого Site (для проверки подписи входящих вебхуков). */
export async function resolveWooWebhookSecret(siteId: string): Promise<string | null> {
  const conn = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: { webhookSecretEncrypted: true },
  });
  if (!conn?.webhookSecretEncrypted) return null;
  return decryptSecret(conn.webhookSecretEncrypted);
}
