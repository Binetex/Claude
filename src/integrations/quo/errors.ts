/**
 * Типы ошибок QUO. Понятные классы под 401/403/404/429/5xx + сетевые сбои. Ретраить можно
 * ТОЛЬКО 429 и временные 5xx (см. isRetryableQuoError). Сообщения — без секретов и без PII.
 */
export type QuoErrorKind = "auth" | "forbidden" | "not_found" | "rate_limit" | "server" | "client" | "network";

export class QuoApiError extends Error {
  constructor(
    message: string,
    readonly kind: QuoErrorKind,
    readonly status: number,
    /** Значение Retry-After в секундах (если пришло от 429), иначе null. */
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "QuoApiError";
  }

  /** Ретраибельна ли ошибка: только 429 и временные 5xx (и сетевые таймауты). */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "network";
  }
}

/** Классифицирует HTTP-статус QUO в типизированную ошибку (без тела/секретов в сообщении). */
export function quoErrorFromStatus(status: number, retryAfterSeconds: number | null = null, safeCode: string | null = null): QuoApiError {
  const suffix = safeCode ? ` (${safeCode})` : "";
  if (status === 401) return new QuoApiError(`QUO unauthorized${suffix}`, "auth", status);
  if (status === 403) return new QuoApiError(`QUO forbidden${suffix}`, "forbidden", status);
  if (status === 404) return new QuoApiError(`QUO not found${suffix}`, "not_found", status);
  if (status === 429) return new QuoApiError(`QUO rate limited${suffix}`, "rate_limit", status, retryAfterSeconds);
  if (status >= 500) return new QuoApiError(`QUO server error ${status}${suffix}`, "server", status);
  return new QuoApiError(`QUO request failed ${status}${suffix}`, "client", status);
}

/** Сетевой сбой (fetch throw / таймаут) — ретраибелен. */
export function quoNetworkError(message: string): QuoApiError {
  return new QuoApiError(`QUO network error: ${message}`, "network", 0);
}

export function isRetryableQuoError(err: unknown): boolean {
  return err instanceof QuoApiError && err.retryable;
}
