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
export type TelegramAudience = "FLORIST" | "OWNER" | "CUSTOMER_SERVICE";

export async function isTelegramGloballyEnabled(prisma: PrismaClient): Promise<boolean> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: "singleton" } }).catch(() => null);
  if (s) return s.enabled;
  return process.env.TELEGRAM_ENABLED === "true";
}

/**
 * Кому сейчас разрешено писать. Выключенная аудитория молчит целиком: событие не уходит, бот
 * остаётся настроенным и включённым, и вернуть поток — один клик, а не перенастройка ботов.
 *
 * Проверка стоит на КАЖДОМ пути отправки, а не внутри резолва бота: тем же резолвом бот
 * достаётся для проверки токена и включения приёма ответов, и администрирование не должно
 * упираться в то, что уведомления этой аудитории временно выключены.
 *
 * Строки настроек нет — считаем, что можно всем: это состояние «ещё ничего не настраивали», и
 * молчать в нём значит потерять уведомления там, где владелец их не выключал.
 */
export async function loadTelegramAudienceFlags(prisma: PrismaClient): Promise<Record<TelegramAudience, boolean>> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: "singleton" } }).catch(() => null);
  return {
    OWNER: s ? s.notifyOwner : true,
    FLORIST: s ? s.notifyFlorists : true,
    CUSTOMER_SERVICE: s ? s.notifyCustomerService : true,
  };
}

export async function isTelegramAudienceOn(prisma: PrismaClient, audience: TelegramAudience): Promise<boolean> {
  return (await loadTelegramAudienceFlags(prisma))[audience];
}
