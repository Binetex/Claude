import "server-only";
/**
 * Доступ к модели ассистента: ключ, адрес API и имя модели.
 *
 * Раньше всё это жило ТОЛЬКО в переменных окружения — сменить модель или ключ можно было лишь
 * через .env на сервере. Теперь настройка живёт в базе и правится в интерфейсе владельцем;
 * окружение осталось запасным вариантом, чтобы ничего не сломалось у уже работающей установки.
 *
 * Приоритет: значение из базы → значение из окружения → умолчание. Ключ хранится зашифрованным
 * (secretBox, тот же приём, что у Burq и Airwallex) и наружу отдаётся только маской.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto/secretBox";
import { getDeepseekConfig, type DeepseekConfig } from "./config";

export type AiModelSettingsView = {
  /** «********cQAA» либо null, если ключ не задан в базе. */
  apiKeyMask: string | null;
  baseUrl: string | null;
  model: string | null;
  checkStatus: string | null;
  checkAt: string | null;
  checkErrorSafe: string | null;
  /** Ключ берётся из окружения (в базе его нет) — так и скажем в интерфейсе. */
  usingEnvKey: boolean;
  /** Что реально уйдёт в API прямо сейчас — с учётом всех запасных вариантов. */
  effectiveBaseUrl: string | null;
  effectiveModel: string | null;
};

const SINGLETON = "singleton";

/** Настройка для показа в интерфейсе. Расшифрованного ключа здесь нет и быть не может. */
export async function loadAiModelSettings(prisma: PrismaClient): Promise<AiModelSettingsView> {
  const row = await prisma.aiAssistantSettings.findUnique({
    where: { id: SINGLETON },
    select: { apiKeyMask: true, apiKeyEncrypted: true, baseUrl: true, model: true, checkStatus: true, checkAt: true, checkErrorSafe: true },
  }).catch(() => null);

  const env = getDeepseekConfig();
  return {
    apiKeyMask: row?.apiKeyMask ?? null,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    checkStatus: row?.checkStatus ?? null,
    checkAt: row?.checkAt ? row.checkAt.toISOString() : null,
    checkErrorSafe: row?.checkErrorSafe ?? null,
    usingEnvKey: !row?.apiKeyEncrypted && !!env,
    effectiveBaseUrl: row?.baseUrl ?? env?.baseUrl ?? null,
    effectiveModel: row?.model ?? env?.model ?? null,
  };
}

/**
 * Рабочая конфигурация вызова модели. База сильнее окружения; если ключа нет нигде — null, и
 * ассистент молчит (это не ошибка, так было и раньше).
 */
export async function resolveDeepseekConfig(prisma: PrismaClient): Promise<DeepseekConfig | null> {
  const env = getDeepseekConfig();
  const row = await prisma.aiAssistantSettings.findUnique({
    where: { id: SINGLETON },
    select: { apiKeyEncrypted: true, baseUrl: true, model: true },
  }).catch(() => null);

  let apiKey = env?.apiKey ?? null;
  if (row?.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(row.apiKeyEncrypted);
    } catch {
      // Ключ шифровался другим CREDENTIALS_ENCRYPTION_KEY — молча падать нельзя, но и ронять
      // обработку входящих тоже: откатываемся на окружение.
      apiKey = env?.apiKey ?? null;
    }
  }
  if (!apiKey) return null;

  const baseUrl = (row?.baseUrl ?? env?.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const model = row?.model ?? env?.model ?? "deepseek-chat";
  return { apiKey, baseUrl, model };
}

export type SaveAiModelInput = {
  /** Пустая строка — не менять ключ. Так же ведут себя настройки Burq и Airwallex. */
  apiKey: string;
  baseUrl: string;
  model: string;
  userId: string;
};

export async function saveAiModelSettings(prisma: PrismaClient, input: SaveAiModelInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const model = input.model.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = input.apiKey.trim();

  if (!model) return { ok: false, error: "Укажите модель." };
  if (baseUrl && !/^https:\/\/[^\s]+$/i.test(baseUrl)) return { ok: false, error: "Адрес API должен начинаться с https://" };

  const secret = apiKey
    ? { apiKeyEncrypted: encryptSecret(apiKey), apiKeyMask: maskSecret(apiKey) }
    : {};

  const data = {
    ...secret,
    baseUrl: baseUrl || null,
    model,
    // Настройки изменились — прежняя отметка о проверке к ним больше не относится.
    checkStatus: "saved_not_checked",
    checkAt: null,
    checkErrorSafe: null,
    updatedByUserId: input.userId,
  };

  await prisma.aiAssistantSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    update: data,
  });
  return { ok: true };
}

/** Убрать ключ из базы: ассистент вернётся к переменным окружения (или замолчит). */
export async function clearAiModelKey(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.aiAssistantSettings.updateMany({
    where: { id: SINGLETON },
    data: { apiKeyEncrypted: null, apiKeyMask: null, checkStatus: null, checkAt: null, checkErrorSafe: null, updatedByUserId: userId },
  });
}

export async function recordAiModelCheck(
  prisma: PrismaClient,
  result: { ok: boolean; errorSafe?: string }
): Promise<void> {
  await prisma.aiAssistantSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, checkStatus: result.ok ? "ok" : "error", checkAt: new Date(), checkErrorSafe: result.errorSafe ?? null },
    update: { checkStatus: result.ok ? "ok" : "error", checkAt: new Date(), checkErrorSafe: result.errorSafe ?? null },
  });
}
