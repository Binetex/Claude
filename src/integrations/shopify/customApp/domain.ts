/**
 * Строгая нормализация и валидация домена магазина Shopify для режима Custom App.
 * Принимаем ТОЛЬКО канонический `*.myshopify.com`. Storefront-домены (`store.com`,
 * `shop.domain.com`, произвольные URL) — отклоняем. Чистые функции — полностью тестируемы.
 */

/** Приводит ввод к «голому» домену: убирает протокол, путь, порт, регистр, пробелы. */
export function normalizeMyshopifyDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .trim();
}

const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type DomainParseResult = { ok: true; domain: string } | { ok: false; reason: string };

/** Валидирует и возвращает канонический домен, либо причину отказа. */
export function parseMyshopifyDomain(input: string): DomainParseResult {
  const domain = normalizeMyshopifyDomain(input);
  if (!domain) return { ok: false, reason: "Укажите домен магазина." };
  if (!MYSHOPIFY_RE.test(domain)) {
    return {
      ok: false,
      reason: "Нужен домен вида my-store.myshopify.com. Storefront-домены (store.com, shop.example.com) не принимаются.",
    };
  }
  return { ok: true, domain };
}

/** true, если строка — валидный `*.myshopify.com`. */
export function isMyshopifyDomain(input: string): boolean {
  return MYSHOPIFY_RE.test(normalizeMyshopifyDomain(input));
}
