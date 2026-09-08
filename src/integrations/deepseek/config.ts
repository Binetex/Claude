import "server-only";
/**
 * ЗАПАСНОЙ доступ к модели из переменных окружения. Основной путь — настройки в интерфейсе
 * (integrations/deepseek/settings.ts): владелец меняет ключ и модель сам, без правки .env и
 * рестарта. Окружение осталось, чтобы уже работающая установка не сломалась и чтобы ассистента
 * можно было поднять до того, как кто-то зайдёт в админку.
 *
 * Ключ один на систему (не на магазин): модель одна, а разделение по магазинам живёт в
 * настройках и базе знаний, а не в биллинге.
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
