import "server-only";
import crypto from "crypto";

const REQUIRED_SCOPES = "read_orders,write_orders,read_products";

function requireEnv(name: "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан — Shopify-интеграция не настроена.`);
  return value;
}

/** Нормализует ввод owner'а до вида "example.myshopify.com". */
export function normalizeShopDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (trimmed.endsWith(".myshopify.com")) return trimmed;
  return `${trimmed}.myshopify.com`;
}

export function isValidShopDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

// Разделитель "|" — доменное имя магазина содержит только [a-z0-9-.], пайп в нём
// появиться не может, так что разбор ниже однозначен (в отличие от "." — сам домен
// уже содержит точки, ".myshopify.com", и наивный split(".") ломался на этом).
const STATE_SEPARATOR = "|";

/** Подписанный state против CSRF в OAuth-редиректе (без БД — просто HMAC от домена+времени). */
export function createOAuthState(shopDomain: string): string {
  const secret = requireEnv("SHOPIFY_CLIENT_SECRET");
  const payload = `${shopDomain}${STATE_SEPARATOR}${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}${STATE_SEPARATOR}${sig}`).toString("base64url");
}

export function verifyOAuthState(state: string, expectedShopDomain: string): boolean {
  try {
    const secret = requireEnv("SHOPIFY_CLIENT_SECRET");
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const [shopDomain, ts, sig] = decoded.split(STATE_SEPARATOR);
    if (shopDomain !== expectedShopDomain) return false;
    const payload = `${shopDomain}${STATE_SEPARATOR}${ts}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (expected.length !== sig.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
    // Ссылка живёт 10 минут — не бессрочный токен.
    return Date.now() - Number(ts) < 10 * 60 * 1000;
  } catch {
    return false;
  }
}

export function buildAuthorizeUrl(shopDomain: string, redirectUri: string, state: string): string {
  const clientId = requireEnv("SHOPIFY_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: REQUIRED_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

/** Проверка HMAC у query-параметров, которые Shopify добавляет к redirect на callback. */
export function verifyCallbackHmac(params: URLSearchParams): boolean {
  const secret = requireEnv("SHOPIFY_CLIENT_SECRET");
  const hmac = params.get("hmac");
  if (!hmac) return false;

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");

  if (expected.length !== hmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
}

/** Обмен временного code на постоянный Admin API access token. */
export async function exchangeCodeForToken(shopDomain: string, code: string): Promise<string> {
  const clientId = requireEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requireEnv("SHOPIFY_CLIENT_SECRET");

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Shopify не вернул access_token");
  return data.access_token;
}
