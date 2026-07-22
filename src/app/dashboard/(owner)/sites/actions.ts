"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import {
  connectCustomApp,
  updateCustomAppCredentials,
  disconnectSite,
  findSiteByDomain,
  ensureWebhooksBestEffort,
} from "@/integrations/shopify/customApp/management";
import { registerWebhooks, REQUIRED_WEBHOOK_TOPICS } from "@/integrations/shopify/customApp/webhookRegistration";
import { checkConnection } from "@/integrations/shopify/customApp/connection";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { prisma } from "@/lib/db";
import { isValidTimeZone } from "@/lib/tz";
import { rescheduleSiteFutureOrders } from "@/integrations/delivery/burq/scheduleService";

type FormState = { error?: string; ok?: boolean; message?: string } | null;

/**
 * Ручная настройка часового пояса магазина (Site.timezone) — общая для всех платформ.
 * Таймзона НЕ берётся из Shopify/WooCommerce API; владелец задаёт её сам. Site.timezone
 * используется во всей date-логике (список закупки, «сегодня», дашборд) — см. lib/tz.
 */
export async function ownerSetSiteTimezone(siteId: string, timezone: string): Promise<FormState> {
  await requireRole("OWNER");
  if (!isValidTimeZone(timezone)) return { error: "Неверная таймзона (нужен IANA-идентификатор, напр. America/Los_Angeles)." };
  await prisma.site.update({ where: { id: siteId }, data: { timezone } });
  // Смена зоны меняет расчёт availableAt (04:00 локального дня) → пере-планировать будущие заказы.
  try {
    await rescheduleSiteFutureOrders(prisma, siteId);
  } catch (err) {
    console.error(`[burq] reschedule site future orders failed (${siteId}):`, err instanceof Error ? err.message : String(err));
  }
  revalidatePath("/dashboard/sites");
  revalidatePath("/dashboard");
  return { ok: true, message: `Часовой пояс: ${timezone}` };
}

/**
 * Стандартный dropoff-текст магазина для Burq draft (Site.burqDefaultDropoffInstructions).
 * Пустая строка → NULL (стандартная инструкция выключена). НЕ трогает уже созданные draft —
 * применяется только к новым (draftPort читает поле при создании каждого черновика).
 */
export async function ownerSetSiteBurqDropoff(siteId: string, text: string): Promise<FormState> {
  await requireRole("OWNER");
  const trimmed = text.trim();
  await prisma.site.update({ where: { id: siteId }, data: { burqDefaultDropoffInstructions: trimmed || null } });
  revalidatePath("/dashboard/sites");
  return { ok: true, message: trimmed ? "Сохранено" : "Стандартная dropoff-инструкция выключена" };
}

function guardCrypto(): string | null {
  return isCredentialCryptoConfigured()
    ? null
    : "Шифрование credentials не настроено: задайте CREDENTIALS_ENCRYPTION_KEY (32 байта base64).";
}

/** Подключить магазин через Custom App (Dev Dashboard + client_credentials). */
export async function ownerConnectCustomApp(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const cryptoErr = guardCrypto();
  if (cryptoErr) return { error: cryptoErr };

  const input = {
    name: String(formData.get("name") ?? ""),
    domain: String(formData.get("domain") ?? ""),
    clientId: String(formData.get("clientId") ?? ""),
    clientSecret: String(formData.get("clientSecret") ?? ""),
    apiVersion: String(formData.get("apiVersion") ?? ""),
  };
  const allowReconnect = String(formData.get("allowReconnect") ?? "") === "1";

  const outcome = await connectCustomApp(input, { allowReconnect });
  revalidatePath("/dashboard/sites");
  if (!outcome.ok) return { error: outcome.error };
  if (!outcome.result.ok) {
    return { error: outcome.result.error ?? "Проверка подключения не прошла." };
  }
  const scopeNote = outcome.result.missingScopes.length
    ? ` Не хватает scopes: ${outcome.result.missingScopes.join(", ")}.`
    : "";
  return {
    ok: true,
    message: `${outcome.reconnected ? "Переподключён" : "Подключён"}: ${outcome.result.shopName} (${outcome.result.myshopifyDomain}).${scopeNote}`,
  };
}

/** Проверить, подключался ли магазин ранее (для подтверждения восстановления). */
export async function ownerLookupExistingSite(domain: string) {
  await requireRole("OWNER");
  return findSiteByDomain(domain);
}

/** Проверить подключение существующего Site. */
export async function ownerCheckConnection(siteId: string): Promise<FormState> {
  await requireRole("OWNER");
  const result = await checkConnection(siteId);
  // Заодно сверяем подписки: проверка подключения — то место, куда владелец идёт при
  // подозрении на проблему, и она должна чинить молча отсутствующие webhook сама.
  await ensureWebhooksBestEffort(siteId, result);
  revalidatePath("/dashboard/sites");
  return result.ok
    ? { ok: true, message: `Подключено: ${result.shopName ?? ""} (${result.myshopifyDomain ?? ""}).` }
    : { error: result.error ?? "Проверка не прошла." };
}

/**
 * Сверяет подписки на webhook с реальным состоянием в Shopify и создаёт недостающие.
 * Идемпотентно: если всё на месте — ничего не меняет. Без подписок магазин не получает заказы.
 */
export async function ownerRegisterWebhooks(siteId: string): Promise<FormState> {
  await requireRole("OWNER");
  try {
    const res = await registerWebhooks(siteId);
    revalidatePath("/dashboard/sites");
    if (res.failed.length > 0) {
      return { error: `Не удалось создать: ${res.failed.map((f) => f.topic).join(", ")}. Проверьте подключение и scopes.` };
    }
    return {
      ok: true,
      message: res.created.length > 0
        ? `Создано подписок: ${res.created.length} (${res.created.join(", ")}). Всего активно ${REQUIRED_WEBHOOK_TOPICS.length}.`
        : `Все ${REQUIRED_WEBHOOK_TOPICS.length} подписок уже на месте.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "Не удалось обратиться к Shopify." };
  }
}

/** Обновить credentials (ротация secret) и перепроверить. */
export async function ownerUpdateCredentials(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const cryptoErr = guardCrypto();
  if (cryptoErr) return { error: cryptoErr };
  const siteId = String(formData.get("siteId") ?? "");
  const result = await updateCustomAppCredentials(siteId, {
    clientId: String(formData.get("clientId") ?? ""),
    clientSecret: String(formData.get("clientSecret") ?? ""),
    apiVersion: String(formData.get("apiVersion") ?? ""),
  });
  revalidatePath("/dashboard/sites");
  return result.ok ? { ok: true, message: "Credentials обновлены." } : { error: result.error ?? "Не удалось обновить." };
}

/** Безопасно отключить магазин (история и товары сохраняются). */
export async function ownerDisconnectSite(siteId: string): Promise<void> {
  await requireRole("OWNER");
  await disconnectSite(siteId);
  revalidatePath("/dashboard/sites");
}
