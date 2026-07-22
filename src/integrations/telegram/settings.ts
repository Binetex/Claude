import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";

/**
 * Глобальные настройки Telegram-уведомлений (singleton). После перехода на персональных ботов
 * здесь остался только общий рубильник: токены, чаты и признак проверки живут на TelegramBot.
 *
 * Колонки botTokenEncrypted/ownerChatId/floristsChatId сохранены в схеме (миграция была
 * additive), но больше не читаются — бот владельца перенесён в TelegramBot.
 */
const SINGLETON = "singleton";

export type TelegramGlobalView = {
  enabled: boolean;
  cryptoConfigured: boolean;
};

export async function loadTelegramGlobalView(prisma: PrismaClient): Promise<TelegramGlobalView> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: SINGLETON } });
  return { enabled: !!s?.enabled, cryptoConfigured: isCredentialCryptoConfigured() };
}

/**
 * Общий выключатель. Проверка здесь не требуется: она выполняется для каждого бота отдельно,
 * а выключать всю рассылку разом нужно уметь в любой момент (аварийный сценарий).
 */
export async function setTelegramGlobalEnabled(prisma: PrismaClient, enabled: boolean): Promise<void> {
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, enabled },
    update: { enabled },
  });
}
