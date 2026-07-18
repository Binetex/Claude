"use server";
/**
 * Серверные actions для WooCommerce-магазинов (owner-only). Отдельно от Shopify actions —
 * Shopify-логику не трогаем. Секреты в чат/логи/ответы не возвращаем.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { connectWooCommerce, updateWooCredentials, disconnectWooSite } from "@/integrations/woocommerce/management";
import { checkWooConnection } from "@/integrations/woocommerce/connection";
import { registerWooWebhooks } from "@/integrations/woocommerce/webhookRegistration";
import { enqueueWooSync } from "@/integrations/woocommerce/syncDispatch";
import { suggestWooMetaKeys } from "@/integrations/woocommerce/metaSuggest";
import { prisma } from "@/lib/db";
import type { OrderMetaMapping } from "@/integrations/woocommerce/orderMeta";

type FormState = { error?: string; ok?: boolean; message?: string } | null;

function guardCrypto(): string | null {
  return isCredentialCryptoConfigured() ? null : "Шифрование credentials не настроено: задайте CREDENTIALS_ENCRYPTION_KEY.";
}

/** Подключить WooCommerce-магазин. */
export async function ownerConnectWoo(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const cryptoErr = guardCrypto();
  if (cryptoErr) return { error: cryptoErr };

  const outcome = await connectWooCommerce(
    {
      name: String(formData.get("name") ?? ""),
      storeUrl: String(formData.get("storeUrl") ?? ""),
      consumerKey: String(formData.get("consumerKey") ?? ""),
      consumerSecret: String(formData.get("consumerSecret") ?? ""),
      apiVersion: String(formData.get("apiVersion") ?? ""),
    },
    { allowReconnect: String(formData.get("allowReconnect") ?? "") === "1" }
  );
  revalidatePath("/dashboard/sites");
  if (!outcome.ok) return { error: outcome.error };
  const r = outcome.result;
  return r.ok
    ? { ok: true, message: `${outcome.reconnected ? "Переподключён" : "Подключён"}: ${r.store?.storeName ?? "магазин"} (${r.status}).` }
    : { error: r.error ?? "Проверка подключения не прошла." };
}

/** Проверить подключение. */
export async function ownerCheckWoo(siteId: string): Promise<FormState> {
  await requireRole("OWNER");
  const r = await checkWooConnection(siteId);
  revalidatePath("/dashboard/sites");
  return r.ok ? { ok: true, message: `Подключение: ${r.status}.` } : { error: r.error ?? "Проверка не прошла." };
}

/** Обновить Consumer Key/Secret. */
export async function ownerUpdateWooCredentials(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const cryptoErr = guardCrypto();
  if (cryptoErr) return { error: cryptoErr };
  const siteId = String(formData.get("siteId") ?? "");
  try {
    const r = await updateWooCredentials(siteId, {
      consumerKey: String(formData.get("consumerKey") ?? ""),
      consumerSecret: String(formData.get("consumerSecret") ?? ""),
    });
    revalidatePath("/dashboard/sites");
    return r.ok ? { ok: true, message: "Credentials обновлены." } : { error: r.error ?? "Не удалось обновить." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Ошибка обновления." };
  }
}

/** Отключить магазин (история/товары/заказы сохраняются). */
export async function ownerDisconnectWoo(siteId: string): Promise<void> {
  await requireRole("OWNER");
  await disconnectWooSite(siteId);
  revalidatePath("/dashboard/sites");
}

/** Зарегистрировать webhooks. */
export async function ownerRegisterWooWebhooks(siteId: string): Promise<FormState> {
  await requireRole("OWNER");
  try {
    const r = await registerWooWebhooks(siteId);
    revalidatePath("/dashboard/sites");
    if (r.failed.length) return { error: `Часть webhooks не создана: ${r.failed.map((f) => f.topic).join(", ")}.` };
    return { ok: true, message: `Webhooks: создано ${r.created.length}, уже было ${r.existing.length}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Не удалось зарегистрировать webhooks." };
  }
}

/** Постановка синхронизации в очередь (worker/outbox), не в HTTP-запросе. */
export async function ownerSyncWoo(siteId: string, kind: "PRODUCTS" | "ORDERS"): Promise<FormState> {
  await requireRole("OWNER");
  await enqueueWooSync(siteId, kind);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: `Синхронизация ${kind === "PRODUCTS" ? "товаров" : "заказов"} поставлена в очередь.` };
}

/**
 * Полная синхронизация: товары + ВСЯ история заказов (watermark игнорируется). Импорт всей
 * истории — по явному подтверждению владельца (UI требует второго клика). Обычная
 * «Синхронизировать заказы» — инкрементальная (см. ownerSyncWoo).
 */
export async function ownerFullSyncWoo(siteId: string): Promise<FormState> {
  await requireRole("OWNER");
  await enqueueWooSync(siteId, "PRODUCTS");
  await enqueueWooSync(siteId, "ORDERS", { fullHistory: true });
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Полная синхронизация (товары + ВСЯ история заказов) поставлена в очередь." };
}

/** READ-ONLY автоподсказка meta-ключей из последних заказов (только имена, без значений). */
export async function ownerFetchWooMetaKeys(siteId: string): Promise<{ ok: boolean; keys?: { key: string; count: number }[]; error?: string }> {
  await requireRole("OWNER");
  try {
    const keys = await suggestWooMetaKeys(siteId);
    return { ok: true, keys };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Не удалось получить ключи." };
  }
}

/** Сохранить сопоставление полей заказа (meta mapping). */
export async function ownerSaveWooMetaMapping(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const siteId = String(formData.get("siteId") ?? "");
  const mapping: OrderMetaMapping = {};
  for (const field of ["deliveryDate", "deliveryWindow", "recipientName", "recipientPhone", "apartment", "cardMessage", "deliveryInstructions", "occasion", "senderName"] as const) {
    const v = String(formData.get(field) ?? "").trim();
    if (v) mapping[field] = v;
  }
  await prisma.wooCommerceConnection.update({ where: { siteId }, data: { orderMetaMapping: mapping } });
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Сопоставление полей сохранено." };
}

/** Сохранить настройки Airwallex/Klarna BNPL. */
export async function ownerSaveWooPaymentConfig(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const siteId = String(formData.get("siteId") ?? "");
  const methodIds = String(formData.get("airwallexPaymentMethodIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intentKey = String(formData.get("paymentIntentStatusKey") ?? "").trim();
  await prisma.wooCommerceConnection.update({
    where: { siteId },
    data: {
      airwallexEnabled: String(formData.get("airwallexEnabled") ?? "") === "on",
      klarnaPayLaterPendingIsConfirmed: String(formData.get("klarnaPayLaterPendingIsConfirmed") ?? "") === "on",
      airwallexPaymentMethodIds: methodIds,
      airwallexMetaKeys: intentKey ? { paymentIntentStatusKey: intentKey } : undefined,
      payLaterMaxWaitMinutes: Number(formData.get("payLaterMaxWaitMinutes") ?? 1440) || 1440,
      unknownBehavior: String(formData.get("unknownBehavior") ?? "HOLD") === "AWAITING_PAYMENT" ? "AWAITING_PAYMENT" : "HOLD",
    },
  });
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Настройки оплаты сохранены." };
}
