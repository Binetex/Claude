import "server-only";
/**
 * Ошибка обращения к API модели. `retryable` отделяет «попробуй позже» от «так и будет».
 *
 * Тексты НЕ называют провайдера: адрес API задаётся в настройках, и за этим клиентом может
 * стоять как DeepSeek, так и OpenAI. Подпись «DeepSeek отклонил ключ» при обращении к OpenAI
 * отправляла бы владельца искать проблему не там.
 */
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
  if (status === 401 || status === 403) return new DeepseekError("auth", `API модели отклонил ключ (${status})`, false);
  if (status === 429) return new DeepseekError("rate_limit", "API модели: превышен лимит запросов", true);
  if (status === 402) return new DeepseekError("no_balance", "API модели: закончился баланс на аккаунте", false);
  if (status >= 500) return new DeepseekError("server", `API модели временно недоступен (${status})`, true);
  return new DeepseekError("client", `API модели отклонил запрос (${status}): ${safe}`, false);
}
