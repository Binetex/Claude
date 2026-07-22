import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Глобальный выключатель внутренних Telegram-уведомлений.
 *
 * Токены и чаты живут на КОНКРЕТНЫХ ботах (TelegramBot): у владельца свой, у каждого флориста
 * свой. Здесь остался только общий рубильник — им владелец гасит всю рассылку разом, не трогая
 * настройки отдельных ботов.
 *
 * Источник истины — TelegramSettings.enabled. Переменная окружения TELEGRAM_ENABLED осталась
 * запасным вариантом для окружений, где строки настроек ещё нет.
 */
export type TelegramAudience = "FLORIST" | "OWNER";

export async function isTelegramGloballyEnabled(prisma: PrismaClient): Promise<boolean> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: "singleton" } }).catch(() => null);
  if (s) return s.enabled;
  return process.env.TELEGRAM_ENABLED === "true";
}
