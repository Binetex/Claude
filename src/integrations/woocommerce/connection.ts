import "server-only";
/**
 * Проверка подключения WooCommerce: пробуем ключевые эндпоинты, снимаем инфо о магазине,
 * выводим статус и сохраняем его на WooCommerceConnection. Импорт НЕ запускаем — только проверка.
 */
import { prisma } from "@/lib/db";
import { resolveWooCredentials, type WooCredentials } from "./credentials";
import { wooGet, WooApiError, type WooClientOptions } from "./client";
import { deriveWooConnection, type WooProbe, type WooProbeSet, type WooStoreInfo, type WooConnectionResult } from "./connectionLogic";

async function probe(fn: () => Promise<unknown>): Promise<WooProbe> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (err instanceof WooApiError) return { ok: false, kind: err.kind, message: err.userMessage };
    return { ok: false, kind: "unknown", message: "Неизвестная ошибка при проверке." };
  }
}

type WooSystemStatus = {
  environment?: { version?: string; wp_version?: string; site_url?: string; currency?: string };
  settings?: { currency?: string };
};

/** Необязательная диагностика: system_status. Недоступность не проваливает проверку. */
async function fetchStoreInfo(creds: WooCredentials, opts: WooClientOptions): Promise<WooStoreInfo | null> {
  try {
    const { data } = await wooGet<WooSystemStatus>(creds, "/system_status", undefined, opts);
    return {
      storeName: null, // system_status не отдаёт имя магазина; берём отдельно ниже, если нужно
      currency: data.settings?.currency ?? data.environment?.currency ?? null,
      // timezone НЕ получаем: WooCommerce REST её не отдаёт и в логике она не используется.
      wooVersion: data.environment?.version ?? null,
      wpVersion: data.environment?.wp_version ?? null,
    };
  } catch {
    return null; // роль без доступа к system_status — не критично
  }
}

/** Запускает проверку подключения и сохраняет результат. Возвращает результат для UI. */
export async function checkWooConnection(siteId: string, opts: WooClientOptions = {}): Promise<WooConnectionResult> {
  const creds = await resolveWooCredentials(siteId);

  // Ключевые пробы: products и orders (read); webhooks — право на управление подписками.
  const [products, orders, webhooks, store] = await Promise.all([
    probe(() => wooGet(creds, "/products", { per_page: 1 }, opts)),
    probe(() => wooGet(creds, "/orders", { per_page: 1 }, opts)),
    probe(() => wooGet(creds, "/webhooks", { per_page: 1 }, opts)),
    fetchStoreInfo(creds, opts),
  ]);

  const probes: WooProbeSet = { products, orders, webhooks, store };
  const result = deriveWooConnection(probes);

  await prisma.wooCommerceConnection.update({
    where: { siteId },
    data: {
      connStatus: result.status,
      connectionError: result.error,
      lastConnectionCheckAt: new Date(),
      ...(result.store
        ? {
            currency: result.store.currency ?? undefined,
            wooVersion: result.store.wooVersion ?? undefined,
            wpVersion: result.store.wpVersion ?? undefined,
          }
        : {}),
    },
  });
  // Зеркалим общий connectionStatus Site (для совместимости с существующим UI-полем).
  await prisma.site.update({
    where: { id: siteId },
    data: { connectionStatus: result.ok ? "CONNECTED" : result.status === "REAUTH_REQUIRED" ? "DISCONNECTED" : "PENDING" },
  });

  return result;
}
