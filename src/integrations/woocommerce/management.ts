import "server-only";
/**
 * Подключение/переподключение/отключение WooCommerce-магазина. Секреты (Consumer Key/Secret
 * и webhook secret) шифруются общим secretBox перед сохранением; в UI/логи не возвращаются.
 * Идемпотентно по нормализованному storeUrl: один Site на магазин, повторное подключение
 * ВОССТАНАВЛИВАЕТ существующий Site (товары/заказы/локальные поля сохраняются).
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { encryptSecret, maskSecret } from "@/lib/crypto/secretBox";
import { normalizeStoreUrl } from "./url";
import { checkWooConnection } from "./connection";
import type { WooConnectionResult } from "./connectionLogic";
import type { WooClientOptions } from "./client";

export type WooConnectInput = {
  name: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  apiVersion?: string;
};

export type WooConnectOutcome =
  | { ok: false; error: string }
  | { ok: true; siteId: string; reconnected: boolean; result: WooConnectionResult };

function shortNameFrom(name: string, fallback: string): string {
  const base = name.trim() || fallback;
  return base.slice(0, 12).toUpperCase().replace(/\s+/g, "") || "WOO";
}

/** Ищем существующий Woo-Site по storeUrl (для восстановления при повторном подключении). */
export async function findWooSiteByStoreUrl(storeUrl: string) {
  return prisma.wooCommerceConnection.findFirst({
    where: { storeUrl },
    select: { siteId: true, connStatus: true, storeUrl: true },
  });
}

export async function connectWooCommerce(
  input: WooConnectInput,
  opts: { allowReconnect?: boolean; client?: WooClientOptions } = {}
): Promise<WooConnectOutcome> {
  const norm = normalizeStoreUrl(input.storeUrl, input.apiVersion);
  if (!norm.ok) return { ok: false, error: norm.reason };
  if (!input.consumerKey.trim() || !input.consumerSecret.trim()) {
    return { ok: false, error: "Укажите Consumer Key и Consumer Secret." };
  }

  const existing = await findWooSiteByStoreUrl(norm.storeUrl);
  if (existing && existing.connStatus === "CONNECTED" && !opts.allowReconnect) {
    return { ok: false, error: "Этот магазин уже подключён. Для смены ключей используйте «Обновить credentials»." };
  }

  const creds = {
    storeUrl: norm.storeUrl,
    apiBaseUrl: norm.apiBaseUrl,
    apiVersion: norm.apiVersion,
    consumerKeyEncrypted: encryptSecret(input.consumerKey.trim()),
    consumerSecretEncrypted: encryptSecret(input.consumerSecret.trim()),
    consumerSecretMask: maskSecret(input.consumerSecret.trim()),
    connStatus: "CONNECTING" as const,
    connectionError: null,
  };

  let siteId: string;
  let reconnected = false;

  if (existing) {
    await prisma.wooCommerceConnection.update({ where: { siteId: existing.siteId }, data: creds });
    siteId = existing.siteId;
    reconnected = true;
  } else {
    // Новый Site + 1:1 WooCommerceConnection в одной транзакции. webhook secret генерируем
    // случайно (НЕ равен consumer secret) и шифруем.
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    try {
      const site = await prisma.site.create({
        data: {
          name: input.name.trim() || norm.storeUrl,
          shortName: shortNameFrom(input.name, norm.storeUrl),
          platform: "WOOCOMMERCE",
          connectionStatus: "PENDING",
          wooConnection: {
            create: { ...creds, webhookSecretEncrypted: encryptSecret(webhookSecret) },
          },
        },
        select: { id: true },
      });
      siteId = site.id;
    } catch (err) {
      // Гонка первого подключения: параллельный create того же storeUrl нарушил
      // @unique(storeUrl) → находим уже созданную запись и ОБНОВЛЯЕМ её (без дубля, без падения).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const race = await findWooSiteByStoreUrl(norm.storeUrl);
        if (!race) throw err;
        await prisma.wooCommerceConnection.update({ where: { siteId: race.siteId }, data: creds });
        siteId = race.siteId;
        reconnected = true;
      } else {
        throw err;
      }
    }
  }

  // Если у восстановленного Site ещё нет webhook secret — создаём.
  const conn = await prisma.wooCommerceConnection.findUnique({ where: { siteId }, select: { webhookSecretEncrypted: true } });
  if (!conn?.webhookSecretEncrypted) {
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    await prisma.wooCommerceConnection.update({ where: { siteId }, data: { webhookSecretEncrypted: encryptSecret(webhookSecret) } });
  }

  const result = await checkWooConnection(siteId, opts.client);
  return { ok: true, siteId, reconnected, result };
}

/** Обновление только Consumer Key/Secret существующего подключения (+перепроверка). */
export async function updateWooCredentials(
  siteId: string,
  input: { consumerKey: string; consumerSecret: string },
  opts: { client?: WooClientOptions } = {}
): Promise<WooConnectionResult> {
  if (!input.consumerKey.trim() || !input.consumerSecret.trim()) {
    throw new Error("Укажите Consumer Key и Consumer Secret.");
  }
  await prisma.wooCommerceConnection.update({
    where: { siteId },
    data: {
      consumerKeyEncrypted: encryptSecret(input.consumerKey.trim()),
      consumerSecretEncrypted: encryptSecret(input.consumerSecret.trim()),
      consumerSecretMask: maskSecret(input.consumerSecret.trim()),
      connStatus: "CONNECTING",
      connectionError: null,
    },
  });
  return checkWooConnection(siteId, opts.client);
}

/**
 * Безопасное отключение: DISCONNECTED, очистка credentials, деактивация вебхуков.
 * Товары/заказы/история и локальные поля НЕ удаляются. Site НЕ удаляется.
 */
export async function disconnectWooSite(siteId: string): Promise<void> {
  await prisma.$transaction([
    prisma.wooCommerceWebhook.updateMany({ where: { siteId }, data: { status: "DELETED" } }),
    prisma.wooCommerceConnection.update({
      where: { siteId },
      data: {
        connStatus: "DISCONNECTED",
        connectionError: null,
        consumerKeyEncrypted: "",
        consumerSecretEncrypted: "",
        consumerSecretMask: "",
        webhookSecretEncrypted: null,
      },
    }),
    prisma.site.update({ where: { id: siteId }, data: { connectionStatus: "DISCONNECTED" } }),
  ]);
}
