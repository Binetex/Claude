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
  /** Кому сейчас разрешено писать. Выключенная аудитория молчит целиком. */
  audiences: TelegramAudiences;
};

/** Три адресата уведомлений. Четвёртого в реестре событий нет. */
export type TelegramAudiences = { owner: boolean; florists: boolean; customerService: boolean };

export async function loadTelegramGlobalView(prisma: PrismaClient): Promise<TelegramGlobalView> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: SINGLETON } });
  return {
    enabled: !!s?.enabled,
    cryptoConfigured: isCredentialCryptoConfigured(),
    // Строки нет — «ещё не настраивали»: пишем всем, как было до появления настройки.
    audiences: {
      owner: s ? s.notifyOwner : true,
      florists: s ? s.notifyFlorists : true,
      customerService: s ? s.notifyCustomerService : true,
    },
  };
}

/**
 * Кому писать. Отдельно от общего рубильника: «выключить всё» и «пока не трогать флористов» —
 * разные решения, и одно не должно прятаться внутри другого.
 */
export async function setTelegramAudiences(prisma: PrismaClient, a: TelegramAudiences): Promise<void> {
  const data = { notifyOwner: a.owner, notifyFlorists: a.florists, notifyCustomerService: a.customerService };
  await prisma.telegramSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, enabled: false, ...data },
    update: data,
  });
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
