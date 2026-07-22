import "server-only";

/**
 * Конфигурация внутренних Telegram-уведомлений. MVP: только env, без UI и без БД —
 * позже заменяется полноценной системой привязки чатов (User.telegramId уже есть в схеме).
 *
 * Отсутствие токена или конкретного chatId НЕ является ошибкой: событие безопасно
 * пропускается (SKIPPED) с безопасной причиной в логе, worker при этом не падает.
 */
export type TelegramAudience = "FLORIST" | "OWNER";

export type TelegramConfig = {
  botToken: string;
  chatByAudience: Partial<Record<TelegramAudience, string>>;
};

/** null — интеграция выключена или не настроена; вызывающий обязан безопасно пропустить событие. */
export function getTelegramConfig(): TelegramConfig | null {
  // Флаг читаем динамически (как isBurqRuntimeEnabled), а не через memoized featureFlags:
  // позволяет включить/выключить без пересборки и корректно проверяется в тестах.
  if (process.env.TELEGRAM_ENABLED !== "true") return null;
  const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) return null;
  const owner = (process.env.TELEGRAM_CHAT_ID_OWNER ?? "").trim();
  const florists = (process.env.TELEGRAM_CHAT_ID_FLORISTS ?? "").trim();
  return {
    botToken,
    chatByAudience: {
      ...(owner ? { OWNER: owner } : {}),
      ...(florists ? { FLORIST: florists } : {}),
    },
  };
}

/** Безопасная причина пропуска — для логов и журнала, без секретов. */
export type SkipReason = "telegram_disabled" | "no_bot_token" | "no_chat_for_audience";

export function resolveChatId(cfg: TelegramConfig | null, audience: TelegramAudience): { chatId: string } | { skip: SkipReason } {
  if (!cfg) return { skip: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim() ? "telegram_disabled" : "no_bot_token" };
  const chatId = cfg.chatByAudience[audience];
  if (!chatId) return { skip: "no_chat_for_audience" };
  return { chatId };
}
