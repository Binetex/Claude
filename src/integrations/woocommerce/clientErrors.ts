/**
 * Классификация ошибок WooCommerce REST в понятные владельцу сообщения. Чистый модуль
 * (без сети/БД/server-only) — полностью тестируем. Тексты без секретов и PII.
 */

export type WooErrorKind =
  | "auth" // 401 — неверные Consumer Key/Secret ИЛИ хостинг/WAF срезал заголовок Authorization
  | "forbidden" // 403 — недостаточно прав пользователя ключа или security-плагин
  | "not_found" // 404 — неверный endpoint / REST API недоступен / permalinks
  | "rate_limited" // 429 — троттлинг
  | "server" // 5xx — ошибка WooCommerce/WordPress/хостинга
  | "network" // сетевая ошибка/таймаут
  | "html" // HTML вместо JSON (REST заблокирован / WAF / permalink)
  | "invalid_json"
  | "unknown";

export class WooApiError extends Error {
  readonly kind: WooErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  /** Человекочитаемое объяснение для владельца (без секретов/PII). */
  readonly userMessage: string;
  constructor(kind: WooErrorKind, userMessage: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(`WooCommerce API error [${kind}]${opts.status ? ` ${opts.status}` : ""}`);
    this.name = "WooApiError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.userMessage = userMessage;
  }
}

/** Похоже ли тело/тип на HTML (а не JSON) — признак заблокированного REST. */
export function htmlLooking(contentType: string, body: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = body.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<br") || head.startsWith("<?xml");
}

/** Короткая безопасная выжимка из тела ошибки WooCommerce ({code,message}) — без PII. */
function wooMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as { message?: string; code?: string };
    if (j && typeof j.message === "string") return j.message.slice(0, 160);
    if (j && typeof j.code === "string") return j.code.slice(0, 80);
  } catch {
    /* тело не JSON */
  }
  return null;
}

/** Маппит не-2xx статус в WooApiError с понятным сообщением и флагом повторяемости. */
export function classifyWooHttpError(status: number, body: string): WooApiError {
  const detail = wooMessage(body);
  const suffix = detail ? ` (${detail})` : "";
  switch (true) {
    case status === 401:
      return new WooApiError(
        "auth",
        "401 — неверные Consumer Key/Secret, либо сервер/прокси/WAF удаляет заголовок Authorization (частая проблема Basic Auth на некоторых хостингах). Проверьте ключи и что хостинг пропускает Authorization." + suffix,
        { status, retryable: false }
      );
    case status === 403:
      return new WooApiError(
        "forbidden",
        "403 — недостаточно прав у пользователя ключа (нужны Read/Write) или запрос блокирует security-плагин/WAF." + suffix,
        { status, retryable: false }
      );
    case status === 404:
      return new WooApiError(
        "not_found",
        "404 — REST API недоступен по этому адресу: проверьте URL магазина, что включены «красивые» permalinks и что WooCommerce REST активен." + suffix,
        { status, retryable: false }
      );
    case status === 429:
      return new WooApiError("rate_limited", "429 — слишком много запросов, магазин временно троттлит. Повторим автоматически." + suffix, {
        status,
        retryable: true,
      });
    case status >= 500 && status <= 599:
      return new WooApiError("server", `Ошибка сервера WooCommerce/WordPress (${status}). Возможен временный сбой или медленный хостинг.` + suffix, {
        status,
        retryable: true,
      });
    default:
      return new WooApiError("unknown", `Неожиданный ответ WooCommerce (HTTP ${status}).` + suffix, { status, retryable: false });
  }
}
