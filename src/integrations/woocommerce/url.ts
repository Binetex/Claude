/**
 * Нормализация и валидация URL WooCommerce-магазина. Чистая функция (без сети/БД), тестируема.
 *
 * Правила (см. ТЗ §2/§3):
 *  - принимаем КОРЕНЬ сайта (https://example.com), а не admin-страницу и не готовый endpoint;
 *  - только HTTPS для production;
 *  - www и без www допустимы (не переписываем — оставляем как ввёл владелец);
 *  - без credentials в URL, без query/hash;
 *  - убираем завершающий slash;
 *  - НЕ допускаем ручной ввод `/wp-json/...` — apiBaseUrl собираем сами;
 *  - apiVersion по умолчанию "wc/v3".
 */

export type WooUrlOk = {
  ok: true;
  storeUrl: string; // "https://example.com" (без trailing slash)
  apiBaseUrl: string; // "https://example.com/wp-json/wc/v3"
  apiVersion: string; // "wc/v3"
};
export type WooUrlErr = { ok: false; reason: string };
export type WooUrlResult = WooUrlOk | WooUrlErr;

const API_VERSION_RE = /^wc\/v[0-9]+$/;

/** Убирает завершающие слэши. */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function normalizeStoreUrl(input: string, apiVersionInput?: string): WooUrlResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "Укажите URL магазина." };

  const apiVersion = (apiVersionInput ?? "").trim() || "wc/v3";
  if (!API_VERSION_RE.test(apiVersion)) {
    return { ok: false, reason: "Неверная версия API. Ожидается формат wc/v3." };
  }

  // Требуем явный протокол, чтобы не угадывать http/https.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Неверный URL. Пример: https://example.com" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "Требуется HTTPS. Введите адрес вида https://example.com" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Уберите логин/пароль из URL — credentials вводятся отдельными полями." };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "Уберите query-параметры и #-якорь — введите только адрес сайта." };
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    return { ok: false, reason: "Неверный домен магазина." };
  }

  const path = stripTrailingSlash(url.pathname); // "" или "/shop"

  // Не принимаем готовый REST endpoint вместо корня — apiBaseUrl собираем сами.
  if (/\/wp-json(\/|$)/i.test(path)) {
    return { ok: false, reason: "Введите корень сайта (https://example.com), а не адрес REST API — /wp-json добавляется автоматически." };
  }
  // Не принимаем admin-страницу.
  if (/\/wp-admin(\/|$)/i.test(path) || /\/wp-login\.php$/i.test(path)) {
    return { ok: false, reason: "Введите корень сайта, а не страницу администратора WordPress." };
  }

  // storeUrl = origin + опциональный подкаталог установки WordPress (например /shop).
  const storeUrl = stripTrailingSlash(`${url.origin}${path}`);
  const apiBaseUrl = `${storeUrl}/wp-json/${apiVersion}`;

  return { ok: true, storeUrl, apiBaseUrl, apiVersion };
}
