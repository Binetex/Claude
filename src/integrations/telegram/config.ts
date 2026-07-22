import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveTelegramSettings } from "./settings";

/**
 * Конфигурация внутренних Telegram-уведомлений.
 *
 * Источник истины — настройки из дашборда (TelegramSettings, токен зашифрован). Переменные
 * окружения остаются ЗАПАСНЫМ вариантом: если строки настроек ещё нет, работает прежняя
 * env-конфигурация. Так переход не ломает уже настроенные окружения.
 *
 * Отсутствие настроек — не ошибка сама по себе: вызывающий решает, что делать. Обработчик
 * различает «осознанно выключено» (штатный no-op) и «включено, но не настроено» (повтор через
 * outbox, чтобы уведомление не пропало молча).
 */
export type TelegramAudience = "FLORIST" | "OWNER";

export type TelegramConfig = {
  botToken: string;
  chatByAudience: Partial<Record<TelegramAudience, string>>;
};

export type SkipReason = "telegram_disabled" | "no_bot_token" | "no_chat_for_audience";

/** null — интеграция выключена или токен не задан. */
export async function getTelegramConfig(prisma: PrismaClient): Promise<TelegramConfig | null> {
  const db = await resolveTelegramSettings(prisma).catch(() => null);

  // Строка настроек существует → она и есть источник истины (в т.ч. флаг включения).
  if (db && (db.botToken || db.ownerChatId || db.floristsChatId)) {
    if (!db.enabled) return null;
    if (!db.botToken) return null;
    return {
      botToken: db.botToken,
      chatByAudience: {
        ...(db.ownerChatId ? { OWNER: db.ownerChatId } : {}),
        ...(db.floristsChatId ? { FLORIST: db.floristsChatId } : {}),
      },
    };
  }

  // Запасной вариант — прежняя env-конфигурация.
  if (process.env.TELEGRAM_ENABLED !== "true") return null;
  const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) return null;
  const owner = (process.env.TELEGRAM_CHAT_ID_OWNER ?? "").trim();
  const florists = (process.env.TELEGRAM_CHAT_ID_FLORISTS ?? "").trim();
  return {
    botToken,
    chatByAudience: { ...(owner ? { OWNER: owner } : {}), ...(florists ? { FLORIST: florists } : {}) },
  };
}

/**
 * Различает «выключено осознанно» и «включено, но не настроено» — от этого зависит,
 * пропустить событие штатно или отдать его на повтор, чтобы оно не потерялось.
 */
export async function isTelegramDeliberatelyDisabled(prisma: PrismaClient): Promise<boolean> {
  const db = await resolveTelegramSettings(prisma).catch(() => null);
  if (db && (db.botToken || db.ownerChatId || db.floristsChatId)) return !db.enabled;
  return process.env.TELEGRAM_ENABLED !== "true";
}

export function resolveChatId(cfg: TelegramConfig | null, audience: TelegramAudience): { chatId: string } | { skip: SkipReason } {
  if (!cfg) return { skip: "no_bot_token" };
  const chatId = cfg.chatByAudience[audience];
  if (!chatId) return { skip: "no_chat_for_audience" };
  return { chatId };
}
