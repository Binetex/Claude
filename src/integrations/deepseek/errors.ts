import "server-only";
/** Ошибка обращения к DeepSeek. `retryable` отделяет «попробуй позже» от «так и будет». */
export class DeepseekError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "DeepseekError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Разбор HTTP-статуса. 429 и 5xx — временные, остальное лечится только правкой запроса. */
export function deepseekErrorFromStatus(status: number, body: string): DeepseekError {
  const safe = body.slice(0, 300);
  if (status === 401 || status === 403) return new DeepseekError("auth", `DeepSeek отклонил ключ (${status})`, false);
  if (status === 429) return new DeepseekError("rate_limit", "DeepSeek: превышен лимит запросов", true);
  if (status === 402) return new DeepseekError("no_balance", "DeepSeek: закончился баланс", false);
  if (status >= 500) return new DeepseekError("server", `DeepSeek временно недоступен (${status})`, true);
  return new DeepseekError("client", `DeepSeek отклонил запрос (${status}): ${safe}`, false);
}
