/**
 * Централизованная политика повторов для интеграций. Единственное место, где живёт
 * логика бэкоффа — адаптеры и хендлеры её не дублируют.
 *
 * Экспоненциальный бэкофф с полным джиттером. Повтор только для ретраябельных ошибок
 * (см. `errors.ts`). `IntegrationError.retryAfterMs` (из Retry-After) имеет приоритет.
 */
import { IntegrationError, isRetryableError } from "./errors";

export type RetryPolicy = {
  maxAttempts: number; // включая первую попытку
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
};

/** Вычисляет задержку перед попыткой `attempt` (1-индекс). Экспонента + полный джиттер. */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = Math.random
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(rand() * exp); // full jitter: [0, exp]
}

export type RunWithRetryOptions = {
  policy?: RetryPolicy;
  /** Инъекция сна (для тестов — можно замокать, чтобы не ждать реально). */
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  /** Колбэк наблюдаемости перед повтором. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Выполняет `fn` с повторами по политике. Повторяет только ретраябельные
 * `IntegrationError`; `auth`/`permanent` пробрасываются сразу. После исчерпания
 * попыток пробрасывает последнюю ошибку.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options: RunWithRetryOptions = {}
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? realSleep;
  const rand = options.rand ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const canRetry = isRetryableError(err) && attempt < policy.maxAttempts;
      if (!canRetry) throw err;

      const retryAfter =
        err instanceof IntegrationError && err.retryAfterMs != null
          ? // Уважаем Retry-After провайдера, но ограничиваем maxDelayMs — чтобы враждебный/
            // ошибочный upstream не заставил ждать произвольно долго.
            Math.min(policy.maxDelayMs, err.retryAfterMs)
          : computeBackoffMs(attempt, policy, rand);
      options.onRetry?.({ attempt, delayMs: retryAfter, error: err });
      await sleep(retryAfter);
    }
  }
  throw lastError;
}
