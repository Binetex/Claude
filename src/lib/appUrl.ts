import "server-only";

/**
 * Публичный базовый URL приложения. Должен совпадать с redirect_uri,
 * зарегистрированным в shopify.app.toml (Shopify сверяет их побайтово).
 */
export function getAppUrl(): string {
  return process.env.APP_URL ?? "https://floremart.com";
}
