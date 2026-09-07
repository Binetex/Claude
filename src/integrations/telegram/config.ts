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
/**
 * Какой поток уведомлений настраиваем. Наборов адресатов два, потому что и выключают их по
 * разным причинам: «пока не пишем флористам про заказы» и «пока не показываем ответы ассистента»
 * — разные решения, и одно не должно гасить другое.
 */
export type TelegramAudienceScope = "SYSTEM" | "ASSISTANT";

export async function loadTelegramAudienceFlags(
  prisma: PrismaClient,
  scope: TelegramAudienceScope = "SYSTEM"
): Promise<Record<TelegramAudience, boolean>> {
  const s = await prisma.telegramSettings.findUnique({ where: { id: "singleton" } }).catch(() => null);
  if (!s) return { OWNER: true, FLORIST: true, CUSTOMER_SERVICE: true };
  return scope === "ASSISTANT"
    ? { OWNER: s.aiNotifyOwner, FLORIST: s.aiNotifyFlorists, CUSTOMER_SERVICE: s.aiNotifyCustomerService }
    : { OWNER: s.notifyOwner, FLORIST: s.notifyFlorists, CUSTOMER_SERVICE: s.notifyCustomerService };
}

export async function isTelegramAudienceOn(
  prisma: PrismaClient,
  audience: TelegramAudience,
  scope: TelegramAudienceScope = "SYSTEM"
): Promise<boolean> {
  return (await loadTelegramAudienceFlags(prisma, scope))[audience];
}
