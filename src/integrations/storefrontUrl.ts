/**
 * Публичная ссылка на товар — та, которую не стыдно отправить клиенту.
 *
 * Каталог Shopify отдаёт ссылки на служебном домене `*.myshopify.com`: он открывается, но в SMS
 * читается как чужой сайт или подделка, и клиент по нему не идёт. Настоящий домен магазина
 * лежит в `Site.storefrontDomain`; здесь мы меняем только хост, путь и параметры не трогаем.
 *
 * Домена нет — ссылки нет. Отдать внутренний домен наружу хуже, чем ответить без ссылки:
 * ассистенту в этом случае велено назвать сайт магазина из базы знаний.
 */
export function publicProductUrl(url: string | null | undefined, storefrontDomain: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/\.myshopify\.com$/i.test(parsed.hostname)) return url;
  const host = normalizeStorefrontDomain(storefrontDomain);
  if (!host) return null;
  parsed.hostname = host;
  parsed.protocol = "https:";
  parsed.port = "";
  return parsed.toString();
}

/**
 * Домен, введённый человеком: «https://paradiseflowersart.com/», «www.Paradise…» — всё это один
 * и тот же хост. Возвращает голый хост в нижнем регистре или null, если это не домен.
 */
export function normalizeStorefrontDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!trimmed || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null;
  // Служебный домен витриной не считается: ради того, чтобы его не показывать, всё и затевалось.
  if (/\.myshopify\.com$/.test(trimmed)) return null;
  return trimmed;
}
