import "server-only";
/**
 * HTTP-клиент WooCommerce REST API v3. Аутентификация — HTTP Basic Auth
 * (Consumer Key как username, Consumer Secret как password) поверх HTTPS. Ключи в query
 * string НЕ передаём (только Basic Auth). Секреты НЕ логируем и НЕ включаем в текст ошибок/URL.
 *
 * Надёжность:
 *  - таймаут на каждый запрос;
 *  - ограниченный экспоненциальный backoff ТОЛЬКО для сетевых ошибок, 429 и временных 5xx;
 *  - 401/403/404 не повторяем (повтор бесполезен);
 *  - детект HTML-ответа (REST заблокирован / security plugin / WAF / неверный permalink).
 */
import type { WooCredentials } from "./credentials";
import { WooApiError, classifyWooHttpError, htmlLooking } from "./clientErrors";

export { WooApiError, type WooErrorKind } from "./clientErrors";

export type WooResponse<T> = {
  data: T;
  /** Всего элементов (X-WP-Total) — для прогресса пагинации. null если не отдан. */
  total: number | null;
  /** Всего страниц (X-WP-TotalPages). null если не отдан. */
  totalPages: number | null;
  status: number;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type WooClientOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Задержка перед повтором (мс) по номеру попытки — инъектируется в тестах (без реального сна). */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function basicAuthHeader(creds: WooCredentials): string {
  const token = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64");
  return `Basic ${token}`;
}

/** Строит полный URL: apiBaseUrl + path + query (ключи в query НЕ добавляем). */
function buildUrl(creds: WooCredentials, path: string, query?: Record<string, string | number | undefined>): string {
  const base = `${creds.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function parseIntHeader(res: Response, name: string): number | null {
  const v = res.headers.get(name);
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Выполняет запрос к WooCommerce REST с retry. GET/PUT/POST. Тело (для PUT/POST) — JSON.
 * Возвращает распарсенный JSON + заголовки пагинации. Бросает WooApiError с понятным сообщением.
 */
export async function wooRequest<T>(
  creds: WooCredentials,
  path: string,
  init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
  opts: WooClientOptions = {}
): Promise<WooResponse<T>> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  const url = buildUrl(creds, path, init.query);
  const method = init.method ?? "GET";

  let lastErr: WooApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: basicAuthHeader(creds),
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();

      // HTML вместо JSON — REST заблокирован / security plugin / WAF / permalink / hosting Basic Auth.
      if (htmlLooking(contentType, text)) {
        throw new WooApiError(
          "html",
          "Сервер вернул HTML вместо JSON. Вероятно, REST API заблокирован (security-плагин, Cloudflare/WAF, неверные permalinks или Basic Auth хостинга). Проверьте, что открывается /wp-json/ и что WooCommerce REST включён.",
          { status: res.status }
        );
      }

      if (!res.ok) {
        const err = classifyWooHttpError(res.status, text);
        // Повторяем только сетевые/429/временные 5xx.
        if (err.retryable && attempt < maxAttempts) {
          lastErr = err;
          await sleep(backoffMs(attempt, res));
          continue;
        }
        throw err;
      }

      let data: T;
      try {
        data = (text ? JSON.parse(text) : null) as T;
      } catch {
        throw new WooApiError("invalid_json", "Ответ WooCommerce не является корректным JSON.", { status: res.status });
      }
      return {
        data,
        total: parseIntHeader(res, "x-wp-total"),
        totalPages: parseIntHeader(res, "x-wp-totalpages"),
        status: res.status,
      };
    } catch (err) {
      if (err instanceof WooApiError) {
        if (err.retryable && attempt < maxAttempts) {
          lastErr = err;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
      // Сетевая ошибка / таймаут (AbortError) — повторяемо.
      const netErr = new WooApiError(
        "network",
        "Не удалось связаться с магазином (таймаут или сетевая ошибка). Проверьте доступность сайта, SSL и что адрес не перенаправляется.",
        { retryable: true }
      );
      if (attempt < maxAttempts) {
        lastErr = netErr;
        await sleep(backoffMs(attempt));
        continue;
      }
      throw netErr;
    }
  }
  // maxAttempts исчерпаны на повторяемой ошибке.
  throw lastErr ?? new WooApiError("unknown", "Неизвестная ошибка WooCommerce API.");
}

/** Экспоненциальный backoff с лёгким jitter; уважает Retry-After при 429, если есть. */
function backoffMs(attempt: number, res?: Response): number {
  const retryAfter = res?.headers.get("retry-after");
  if (retryAfter) {
    const s = parseInt(retryAfter, 10);
    if (Number.isFinite(s)) return Math.min(s * 1000, 10_000);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 4_000);
  return base + Math.floor(Math.random() * 250);
}

/** Удобный GET. */
export function wooGet<T>(
  creds: WooCredentials,
  path: string,
  query?: Record<string, string | number | undefined>,
  opts?: WooClientOptions
): Promise<WooResponse<T>> {
  return wooRequest<T>(creds, path, { method: "GET", query }, opts);
}
