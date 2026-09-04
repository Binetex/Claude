import "server-only";
/**
 * Доступ к DeepSeek. Ключ один на систему (не на магазин): модель одна, а разделение по
 * магазинам живёт в настройках и базе знаний, а не в биллинге.
 *
 * Ключ берём из окружения, а не из БД: он не меняется руками через интерфейс, и лишняя таблица
 * с секретом здесь ничего не добавляет.
 */
export type DeepseekConfig = { apiKey: string; baseUrl: string; model: string };

/** Дешёвая модель общего назначения — для коротких ответов клиенту её достаточно. */
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

export function getDeepseekConfig(): DeepseekConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null; // не настроен — ассистент молчит, это не ошибка
  return {
    apiKey,
    baseUrl: (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
  };
}
