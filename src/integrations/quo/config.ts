import "server-only";
/**
 * Конфиг QUO из окружения. Секреты — только в env (никогда в git). QUO_ENABLED уже существует
 * (featureFlags.quo). Реальные значения задаются в prod .env; здесь только чтение + дефолты.
 */
export const QUO_DEFAULT_BASE_URL = "https://api.openphone.com/v1";

export type QuoConfig = { apiKey: string; baseUrl: string };

/** null, если ключ не задан — рантайм-пути становятся no-op (как master-gate). */
export function getQuoConfig(): QuoConfig | null {
  const apiKey = process.env.QUO_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.QUO_API_BASE_URL?.trim() || QUO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

/**
 * Ключи подписи webhook (base64), по одному на каждый созданный в QUO webhook. Проверяем подпись
 * против любого из них (у разных webhook разные key). Формат env: значения через запятую.
 */
export function getQuoSigningKeys(): string[] {
  const raw = process.env.QUO_WEBHOOK_SIGNING_KEYS?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
