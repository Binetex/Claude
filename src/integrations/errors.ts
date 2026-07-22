/**
 * Типизированные ошибки интеграций. Адаптеры бросают `IntegrationError` с явной
 * классификацией, а централизованная retry-политика (`retry.ts`) решает по `kind`,
 * повторять ли вызов. Хендлеры не содержат собственной retry-логики.
 *
 * Чистый модуль (без server-only) — используется и в тестах, и в адаптерах.
 */

export type IntegrationErrorKind =
  | "retryable" // временный сбой (сеть/5xx) — можно повторить
  | "rate_limit" // 429 — повторить с бэкоффом/после Retry-After
  | "auth" // невалидные/просроченные credentials — повтор бесполезен, нужна переустановка
  | "permanent"; // логическая/4xx-ошибка — повтор бесполезен

export class IntegrationError extends Error {
  readonly kind: IntegrationErrorKind;
  readonly platform: string;
  /** HTTP-статус или код провайдера, если есть. */
  readonly statusCode?: number;
  /** Через сколько мс безопасно повторить (из Retry-After), если известно. */
  readonly retryAfterMs?: number;
  /** Исходная причина. */
  readonly cause?: unknown;

  constructor(
    message: string,
    opts: {
      kind: IntegrationErrorKind;
      platform: string;
      statusCode?: number;
      retryAfterMs?: number;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "IntegrationError";
    this.kind = opts.kind;
    this.platform = opts.platform;
    this.statusCode = opts.statusCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts.cause;
  }

  /** Стоит ли повторять вызов при этой ошибке. */
  get isRetryable(): boolean {
    return this.kind === "retryable" || this.kind === "rate_limit";
  }
}

/** Классифицирует HTTP-статус во вид ошибки. Точка правды для адаптеров. */
export function classifyHttpStatus(status: number): IntegrationErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "retryable";
  return "permanent"; // прочие 4xx
}

/** true, если ошибка (любого типа) допускает повтор. */
export function isRetryableError(err: unknown): boolean {
  return err instanceof IntegrationError && err.isRetryable;
}
