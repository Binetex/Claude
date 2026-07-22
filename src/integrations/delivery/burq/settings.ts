import "server-only";
/**
 * Настройки/credentials Burq (глобальный singleton BurqSettings). Секреты (API Key, Webhook
 * Secret) хранятся ТОЛЬКО зашифрованными (AES-256-GCM, secretBox); наружу отдаются лишь маски.
 * Открытый текст НИКОГДА не логируется, не кладётся в ошибки/outbox/HTML/browser-state.
 *
 * Sandbox и Production используют ОДИН host (https://api.burqup.com/v2); режим определяется
 * ТЕСТОВЫМ vs боевым ключом (в ответе Burq — test_mode). `environment` тут — метка + гейт
 * для кнопки sandbox-draft и предупреждений UI.
 */
import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { checkBurqAuth, createRealBurqClient, createMockBurqClient, type BurqClient } from "./client";
import { DEFAULT_BURQ_DIMENSIONS, type BurqDimensions } from "./request";

export const BURQ_DEFAULT_BASE_URL = "https://api.burqup.com/v2";
export const BURQ_WEBHOOK_PATH = "/api/webhooks/burq";
const SINGLETON = "singleton";

export type BurqEnvironment = "SANDBOX" | "PRODUCTION";

/** Безопасное представление для UI — только маски и не-секретные поля. */
export type BurqSettingsView = {
  environment: BurqEnvironment;
  apiKeyMask: string | null;
  webhookSecretMask: string | null;
  apiBaseUrl: string;
  enabled: boolean;
  draftCreationEnabled: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  lastConnectionCheckAt: string | null;
  connectionStatus: string | null;
  connectionErrorSafe: string | null;
  cryptoConfigured: boolean;
  dimensions: BurqDimensions; // глобальные order-level размеры (эффективные: настройка или дефолт)
};

async function readRow() {
  return prisma.burqSettings.findUnique({ where: { id: SINGLETON } });
}

type DimRow = { packageLength: number | null; packageWidth: number | null; packageHeight: number | null; packageWeight: number | null; dimensionUnit: string; weightUnit: string };

/** Эффективные размеры: значение из настроек или дефолт (по каждому полю). */
function effectiveDimensions(row: DimRow | null | undefined): BurqDimensions {
  return {
    length: row?.packageLength ?? DEFAULT_BURQ_DIMENSIONS.length,
    width: row?.packageWidth ?? DEFAULT_BURQ_DIMENSIONS.width,
    height: row?.packageHeight ?? DEFAULT_BURQ_DIMENSIONS.height,
    weight: row?.packageWeight ?? DEFAULT_BURQ_DIMENSIONS.weight,
    dimensionUnit: row?.dimensionUnit || DEFAULT_BURQ_DIMENSIONS.dimensionUnit,
    weightUnit: row?.weightUnit || DEFAULT_BURQ_DIMENSIONS.weightUnit,
  };
}

/** Глобальные order-level размеры для построения Burq-запроса (настройка или дефолт). */
export async function getBurqDimensions(): Promise<BurqDimensions> {
  return effectiveDimensions(await readRow());
}

/** Настройки для UI. НИКОГДА не возвращает зашифрованные значения или открытый текст. */
export async function loadBurqSettingsForUi(): Promise<BurqSettingsView> {
  const row = await readRow();
  return {
    environment: (row?.environment as BurqEnvironment) ?? "SANDBOX",
    apiKeyMask: row?.apiKeyMask ?? null,
    webhookSecretMask: row?.webhookSecretMask ?? null,
    apiBaseUrl: row?.apiBaseUrl || BURQ_DEFAULT_BASE_URL,
    enabled: row?.enabled ?? false,
    draftCreationEnabled: row?.draftCreationEnabled ?? false,
    hasApiKey: !!row?.apiKeyEncrypted,
    hasWebhookSecret: !!row?.webhookSecretEncrypted,
    lastConnectionCheckAt: row?.lastConnectionCheckAt ? row.lastConnectionCheckAt.toISOString() : null,
    connectionStatus: row?.connectionStatus ?? null,
    connectionErrorSafe: row?.connectionErrorSafe ?? null,
    cryptoConfigured: isCredentialCryptoConfigured(),
    dimensions: effectiveDimensions(row),
  };
}

async function audit(userId: string, action: string, environment: BurqEnvironment, detailSafe?: string) {
  await prisma.burqSettingsAudit.create({ data: { userId, action, environment, detailSafe: detailSafe ?? null } });
}

export type SaveBurqInput = {
  environment: BurqEnvironment;
  apiKey?: string; // пусто/undefined → не менять
  webhookSecret?: string; // пусто/undefined → не менять
  apiBaseUrl?: string;
  enabled: boolean;
  /** Глобальные order-level размеры (undefined-поля → не менять/дефолт). */
  dimensions?: Partial<BurqDimensions>;
};

/**
 * Сохранение настроек Burq. Секреты шифруются немедленно; хранятся только зашифрованно + маска.
 * Пустое поле секрета означает «не менять» (не затираем ранее сохранённый ключ).
 * draftCreationEnabled НЕ трогаем здесь — отдельный гейт (см. setBurqDraftCreation).
 */
export async function saveBurqSettings(input: SaveBurqInput, userId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isCredentialCryptoConfigured()) {
    return { ok: false, error: "Шифрование credentials не настроено (CREDENTIALS_ENCRYPTION_KEY)." };
  }
  const apiKey = input.apiKey?.trim();
  const webhookSecret = input.webhookSecret?.trim();
  const baseUrl = input.apiBaseUrl?.trim() || BURQ_DEFAULT_BASE_URL;

  const d = input.dimensions;
  const posOrNull = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const data: Record<string, unknown> = {
    environment: input.environment,
    apiBaseUrl: baseUrl,
    enabled: input.enabled,
    ...(d
      ? {
          packageLength: posOrNull(d.length),
          packageWidth: posOrNull(d.width),
          packageHeight: posOrNull(d.height),
          packageWeight: posOrNull(d.weight),
          dimensionUnit: d.dimensionUnit === "cm" ? "cm" : "in",
          weightUnit: ["lb", "kg", "g"].includes(d.weightUnit ?? "") ? d.weightUnit : "lb",
        }
      : {}),
  };
  if (apiKey) {
    data.apiKeyEncrypted = encryptSecret(apiKey);
    data.apiKeyMask = maskSecret(apiKey);
  }
  if (webhookSecret) {
    data.webhookSecretEncrypted = encryptSecret(webhookSecret);
    data.webhookSecretMask = maskSecret(webhookSecret);
  }

  await prisma.burqSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...(data as object) },
    update: data as object,
  });
  await audit(userId, "save_credentials", input.environment, `enabled=${input.enabled}; keyUpdated=${!!apiKey}; secretUpdated=${!!webhookSecret}`);
  return { ok: true };
}

/** Отдельный гейт авто-создания draft. ВЫКЛ до подтверждения sandbox. */
export async function setBurqDraftCreation(enabled: boolean, userId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await readRow();
  if (!row) return { ok: false, error: "Сначала сохраните настройки Burq." };
  await prisma.burqSettings.update({ where: { id: SINGLETON }, data: { draftCreationEnabled: enabled } });
  await audit(userId, "toggle_draft_creation", row.environment as BurqEnvironment, `draftCreationEnabled=${enabled}`);
  return { ok: true };
}

/** Внутреннее: расшифрованный runtime для connection check / sandbox-draft. НЕ отдаётся в UI. */
async function getDecryptedRuntime(): Promise<{ apiKey: string; baseUrl: string; environment: BurqEnvironment } | null> {
  const row = await readRow();
  if (!row?.apiKeyEncrypted) return null;
  return {
    apiKey: decryptSecret(row.apiKeyEncrypted),
    baseUrl: row.apiBaseUrl || BURQ_DEFAULT_BASE_URL,
    environment: row.environment as BurqEnvironment,
  };
}

/**
 * Webhook signing secret для проверки подписи. Источник — DB (BurqSettings, введён в UI),
 * с env-fallback (BURQ_WEBHOOK_SECRET). Возвращает null, если не задан. НИКОГДА не логировать.
 */
export async function getBurqWebhookSecret(): Promise<string | null> {
  const row = await readRow();
  if (row?.webhookSecretEncrypted) return decryptSecret(row.webhookSecretEncrypted);
  return process.env.BURQ_WEBHOOK_SECRET || null;
}

/** Runtime-конфиг реального Burq-клиента: ключ/baseUrl из DB (env-fallback). null — ключа нет. */
async function getBurqRuntimeConfig(): Promise<{ apiKey: string; baseUrl: string } | null> {
  const row = await readRow();
  if (row?.apiKeyEncrypted) return { apiKey: decryptSecret(row.apiKeyEncrypted), baseUrl: row.apiBaseUrl || BURQ_DEFAULT_BASE_URL };
  const envKey = process.env.BURQ_API_KEY;
  if (envKey) return { apiKey: envKey, baseUrl: process.env.BURQ_API_BASE || BURQ_DEFAULT_BASE_URL };
  return null;
}

/**
 * Клиент Burq для АВТОМАТИЧЕСКОГО пайплайна (worker draft-create, reassignment). Реальный ТОЛЬКО
 * при BURQ_RUNTIME_ENABLED=true И наличии сохранённого ключа; иначе mock. Это гарантирует, что при
 * выключенном runtime (тесты, продакшн до включения) реальные вызовы Burq не происходят.
 */
export async function getBurqRuntimeClient(): Promise<BurqClient> {
  if (!isBurqRuntimeEnabled()) return createMockBurqClient();
  const cfg = await getBurqRuntimeConfig();
  return cfg ? createRealBurqClient(cfg) : createMockBurqClient();
}

/**
 * Проверка подключения: безопасный read-only `GET /orders?limit=1` (сущности НЕ создаются).
 * Результат (ok/unauthorized/error) сохраняется; секреты нигде не фигурируют.
 */
export async function checkBurqConnection(userId: string): Promise<{ ok: boolean; status: string; message: string }> {
  const rt = await getDecryptedRuntime();
  if (!rt) return { ok: false, status: "no_key", message: "Сначала сохраните API Key." };

  const result = await checkBurqAuth({ apiKey: rt.apiKey, baseUrl: rt.baseUrl });
  const connectionStatus = result.ok ? "ok" : result.status === 401 || result.status === 403 ? "unauthorized" : "error";
  const connectionErrorSafe = result.ok ? null : result.safeMessage;

  await prisma.burqSettings.update({
    where: { id: SINGLETON },
    data: { lastConnectionCheckAt: new Date(), connectionStatus, connectionErrorSafe },
  });
  await audit(userId, "connection_check", rt.environment, `status=${connectionStatus}`);

  const message = result.ok
    ? "Подключение успешно (ключ принят Burq)."
    : connectionStatus === "unauthorized"
      ? "Ключ отклонён Burq (unauthorized). Проверьте API Key и окружение."
      : `Не удалось проверить: ${connectionErrorSafe ?? "ошибка сети"}.`;
  return { ok: result.ok, status: connectionStatus, message };
}
