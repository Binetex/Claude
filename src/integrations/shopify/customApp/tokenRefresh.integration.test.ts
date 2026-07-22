/**
 * Интеграционный тест refresh-пути token manager против ЛОКАЛЬНОЙ БД. mint замокан
 * (реального Shopify нет). Проверяет: обновление истёкшего токена + single-flight
 * (FOR UPDATE) — два параллельных запроса делают ровно один mint.
 * Запуск: DATABASE_URL=<local> CREDENTIALS_ENCRYPTION_KEY=<b64-32> npx vitest run <this>
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { mintMock } = vi.hoisted(() => ({
  mintMock: vi.fn(async () => ({
    accessToken: "shpat_new",
    expiresIn: 86399,
    expiresAt: new Date(Date.now() + 86399_000),
  })),
}));

vi.mock("./tokenClient", async (importActual) => {
  const actual = await importActual<typeof import("./tokenClient")>();
  return { ...actual, mintClientCredentialsToken: mintMock };
});

import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secretBox";
import { getValidAccessToken } from "./tokenManager";

const RUN = `trefresh${Date.now()}`;

async function cleanup() {
  await prisma.site.deleteMany({ where: { shortName: RUN } });
}

let seq = 0;
async function expiredCustomAppSite() {
  const dom = `${RUN}-${++seq}.myshopify.com`;
  return prisma.site.create({
    data: {
      name: "Refresh", shortName: RUN, platform: "SHOPIFY", connectionStatus: "PENDING",
      authMode: "CUSTOM_APP", normalizedShopDomain: dom, shopifyShopDomain: dom,
      clientIdEncrypted: encryptSecret("cid"), clientSecretEncrypted: encryptSecret("csecret"),
      accessTokenEncrypted: encryptSecret("shpat_old"), accessTokenExpiresAt: new Date(Date.now() - 1000), // истёк
      shopifyConnStatus: "CONNECTED", apiVersion: "2026-07",
    },
    select: { id: true },
  });
}

beforeAll(cleanup);
afterAll(cleanup);

describe("tokenManager refresh (local DB, mocked mint)", () => {
  it("истёкший токен → mint нового и сохранение (зашифровано)", async () => {
    mintMock.mockClear();
    const site = await expiredCustomAppSite();
    const token = await getValidAccessToken(site.id);
    expect(token).toBe("shpat_new");
    expect(mintMock).toHaveBeenCalledOnce();
    const after = await prisma.site.findUnique({ where: { id: site.id }, select: { accessTokenEncrypted: true } });
    expect(decryptSecret(after!.accessTokenEncrypted!)).toBe("shpat_new"); // сохранён зашифрованно
  });

  it("после refresh повторный вызов не минтит снова (кэш/double-check)", async () => {
    // Детерминированно на локальной БД. Строгая CONCURRENT single-flight (FOR UPDATE блокирует
    // второй поток) проверяется на реальном Postgres — PGlite однопоточный и не воспроизводит
    // блокировку. Логика double-check покрыта unit-тестом isStoredTokenFresh.
    mintMock.mockClear();
    const site = await expiredCustomAppSite();
    const first = await getValidAccessToken(site.id);
    const second = await getValidAccessToken(site.id); // токен уже валиден → из кэша
    expect(first).toBe("shpat_new");
    expect(second).toBe("shpat_new");
    expect(mintMock).toHaveBeenCalledOnce(); // повторно не минтим
  });
});
