/**
 * Чистый клиент получения access token Shopify Custom App через client_credentials grant.
 * Без БД и без побочных эффектов — `fetch` инъектируется, поэтому полностью тестируется.
 *
 * Официально (shopify.dev, 2026): client_credentials работает ТОЛЬКО когда app и store в одной
 * Shopify-организации; токен живёт 24ч (`expires_in=86399`), absolute-expiry не возвращается —
 * считаем `now + expires_in`. Endpoint/тело — см. ниже.
 *
 * ВАЖНО: этот модуль НЕ логирует client_secret и токен.
 */

/** Обновляем токен заранее — за это время до истечения. */
export const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 минут

export type MintTokenParams = {
  shopDomain: string; // канонический "*.myshopify.com"
  clientId: string;
  clientSecret: string;
};

export type MintedToken = {
  accessToken: string;
  expiresIn: number; // секунды
  expiresAt: Date;
};

export type ShopifyAuthErrorKind =
  | "invalid_client" // неверные client_id/secret, отозван secret, удалён app, не same-org → REAUTH_REQUIRED
  | "http" // прочий не-2xx (временный) → повтор допустим
  | "parse"; // некорректный ответ

export class ShopifyAuthError extends Error {
  readonly kind: ShopifyAuthErrorKind;
  readonly status?: number;
  /** Требуется повторная авторизация владельцем (обновить Client ID/Secret). */
  readonly requiresReauth: boolean;
  constructor(message: string, kind: ShopifyAuthErrorKind, status?: number) {
    super(message);
    this.name = "ShopifyAuthError";
    this.kind = kind;
    this.status = status;
    this.requiresReauth = kind === "invalid_client";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function safeBodyText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200); // усечение, тело ответа Shopify не содержит наш secret
  } catch {
    return "";
  }
}

/**
 * Получает access token grant'ом client_credentials.
 * POST https://{shop}/admin/oauth/access_token
 * Content-Type: application/x-www-form-urlencoded
 * body: grant_type=client_credentials & client_id & client_secret
 */
export async function mintClientCredentialsToken(
  params: MintTokenParams,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date()
): Promise<MintedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await fetchImpl(`https://${params.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    // Таймаут короче транзакционного (20с): зависший upstream быстро освобождает row-lock.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await safeBodyText(res);
    // 400/401/403 или тело с invalid_client → неверные/отозванные credentials, повтор бесполезен.
    const authFail = res.status === 400 || res.status === 401 || res.status === 403 || /invalid_client|invalid_request|unauthorized/i.test(text);
    throw new ShopifyAuthError(
      `client_credentials failed: HTTP ${res.status}`,
      authFail ? "invalid_client" : "http",
      res.status
    );
  }

  let data: { access_token?: string; expires_in?: number };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new ShopifyAuthError("Некорректный JSON ответа токена", "parse", res.status);
  }
  if (!data.access_token) {
    throw new ShopifyAuthError("Ответ без access_token", "parse", res.status);
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 86399;
  return {
    accessToken: data.access_token,
    expiresIn,
    expiresAt: new Date(now().getTime() + expiresIn * 1000),
  };
}

/** true, если токена нет или он истекает в пределах буфера. */
export function needsRefresh(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
  bufferMs: number = TOKEN_REFRESH_BUFFER_MS
): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - now.getTime() <= bufferMs;
}

/**
 * Решает (после захвата lock), актуален ли уже сохранённый токен и можно ли вернуть его
 * без повторного минта. Ключевое: при `forced` (после 401) «свежим» считается ТОЛЬКО
 * изменившийся токен (кто-то другой уже перемитил) — иначе 401-recovery переиспользовал бы
 * тот же мёртвый токен. Чистая функция — покрыта тестами.
 */
export function isStoredTokenFresh(params: {
  storedToken: string | null | undefined;
  storedExpiresAt: Date | null | undefined;
  forced: boolean;
  staleToken?: string | null;
  now?: Date;
  bufferMs?: number;
}): boolean {
  if (!params.storedToken) return false;
  if (params.forced) return params.storedToken !== params.staleToken;
  return !needsRefresh(params.storedExpiresAt, params.now, params.bufferMs);
}
