import "server-only";
/**
 * Управление 24-часовым access token Shopify Custom App на уровне Site.
 *
 * Single-flight: обновление токена выполняется под блокировкой строки Site
 * (`SELECT … FOR UPDATE` в транзакции) с ПОВТОРНОЙ проверкой после захвата lock — так
 * несколько параллельных запросов (адаптеры/worker/webhook) не намитят несколько токенов
 * и не перезапишут друг друга. DB-backed lock, а не JS Map (переживает несколько инстансов).
 *
 * Секреты нигде не логируются. Требует применённой миграции 20260718050000_shopify_custom_app.
 */
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto/secretBox";
import { mintClientCredentialsToken, needsRefresh, isStoredTokenFresh, ShopifyAuthError, type MintedToken } from "./tokenClient";

export class SiteNotConnectedError extends Error {
  constructor(public readonly siteId: string, message: string) {
    super(message);
    this.name = "SiteNotConnectedError";
  }
}

type TokenColumns = {
  id: string;
  authMode: string | null;
  normalizedShopDomain: string | null;
  clientIdEncrypted: string | null;
  clientSecretEncrypted: string | null;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  shopifyConnStatus: string | null;
};

/**
 * Возвращает валидный access token для Site (минтит/обновляет при необходимости).
 * `forceRefresh` — принудительно обновить (после 401).
 */
export async function getValidAccessToken(siteId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  // Быстрый путь без блокировки: если токен ещё валиден и не форсим — отдаём.
  const site = (await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true, authMode: true, normalizedShopDomain: true,
      clientIdEncrypted: true, clientSecretEncrypted: true,
      accessTokenEncrypted: true, accessTokenExpiresAt: true, shopifyConnStatus: true,
    },
  })) as TokenColumns | null;

  if (!site) throw new SiteNotConnectedError(siteId, "Site не найден");
  if (site.authMode !== "CUSTOM_APP") throw new SiteNotConnectedError(siteId, "Site не в режиме CUSTOM_APP");

  if (!opts.forceRefresh && site.accessTokenEncrypted && !needsRefresh(site.accessTokenExpiresAt)) {
    return decryptSecret(site.accessTokenEncrypted);
  }
  // При forceRefresh (после 401) передаём «протухший» шифртекст: под lock перемитим, если
  // никто другой уже не заменил его на новый — иначе 401-recovery переиспользовал бы мёртвый токен.
  return refreshWithLock(siteId, opts.forceRefresh ? { staleToken: site.accessTokenEncrypted } : {});
}

/** Обновление токена под блокировкой строки Site. Кидает ShopifyAuthError при неверных credentials. */
export async function refreshWithLock(siteId: string, opts: { staleToken?: string | null } = {}): Promise<string> {
  const forced = "staleToken" in opts;
  return prisma.$transaction(
    async (tx) => {
      // Захватываем эксклюзивную блокировку строки Site — сериализуем обновления токена.
      await tx.$queryRaw`SELECT id FROM "Site" WHERE id = ${siteId} FOR UPDATE`;

      const site = (await tx.site.findUnique({
        where: { id: siteId },
        select: {
          id: true, authMode: true, normalizedShopDomain: true,
          clientIdEncrypted: true, clientSecretEncrypted: true,
          accessTokenEncrypted: true, accessTokenExpiresAt: true, shopifyConnStatus: true,
        },
      })) as TokenColumns | null;
      if (!site) throw new SiteNotConnectedError(siteId, "Site не найден");

      // Double-check после захвата lock: возможно, другой поток уже обновил токен.
      if (
        isStoredTokenFresh({
          storedToken: site.accessTokenEncrypted,
          storedExpiresAt: site.accessTokenExpiresAt,
          forced,
          staleToken: opts.staleToken,
        })
      ) {
        return decryptSecret(site.accessTokenEncrypted!);
      }
      if (!site.clientIdEncrypted || !site.clientSecretEncrypted || !site.normalizedShopDomain) {
        throw new SiteNotConnectedError(siteId, "Не заданы credentials Custom App");
      }

      const clientId = decryptSecret(site.clientIdEncrypted);
      const clientSecret = decryptSecret(site.clientSecretEncrypted);

      let minted: MintedToken;
      try {
        minted = await mintClientCredentialsToken({ shopDomain: site.normalizedShopDomain, clientId, clientSecret });
      } catch (err) {
        // Неверные/отозванные credentials → помечаем REAUTH_REQUIRED (синхронизация встанет).
        if (err instanceof ShopifyAuthError && err.requiresReauth) {
          await tx.site.update({
            where: { id: siteId },
            data: { shopifyConnStatus: "REAUTH_REQUIRED", connectionError: "Credentials больше не действуют. Обновите Client ID и Client Secret." },
          });
        }
        throw err;
      }

      await tx.site.update({
        where: { id: siteId },
        data: {
          accessTokenEncrypted: encryptSecret(minted.accessToken),
          accessTokenMask: maskSecret(minted.accessToken),
          accessTokenExpiresAt: minted.expiresAt,
        },
      });
      return minted.accessToken;
    },
    { timeout: 20_000 } // держим транзакцию во время сетевого mint (обычно <1с)
  );
}
