import "server-only";
/**
 * «Робот отправки вышел из аккаунта Quo» — владельцу в Telegram, не чаще раза в сутки.
 *
 * SMS при этом не теряются: уходят через API, только платно. Вернуть бесплатную отправку может лишь
 * владелец — войти заново (`npm run quo:login` на своём компьютере) и положить сессию на сервер;
 * робот сам не входит. Окно «уже говорили» — в памяти процесса, как у сигнала о пустом балансе
 * (`quo/balanceAlert.ts`): после перезапуска воркера владелец узнает снова, и это правильно.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveOwnerBot } from "@/integrations/telegram/bots";
import { isTelegramGloballyEnabled, isTelegramAudienceOn } from "@/integrations/telegram/config";
import { TelegramSender } from "@/integrations/telegram/sender";

const ALERT_EVERY_HOURS = 24;
let lastAlertAt: number | null = null;

export async function alertQuoBrowserLoggedOut(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  try {
    if (lastAlertAt != null && now.getTime() - lastAlertAt < ALERT_EVERY_HOURS * 3_600_000) return;
    if (!(await isTelegramGloballyEnabled(prisma))) return;
    if (!(await isTelegramAudienceOn(prisma, "OWNER"))) return;
    const lookup = await resolveOwnerBot(prisma);
    if (!("bot" in lookup)) return;

    lastAlertAt = now.getTime();
    const text = [
      "🔐 <b>Quo: робот отправки SMS вышел из аккаунта</b>",
      "",
      "SMS клиентам не теряются — уходят через API, но платно ($0.01 за часть).",
      "Чтобы вернуть бесплатную отправку, войдите в Quo заново: на компьютере владельца",
      "<code>npm run quo:login</code>, затем файл сессии — на сервер.",
      "",
      "Следующее такое сообщение — не раньше чем через сутки.",
    ].join("\n");
    await new TelegramSender(lookup.bot.token).sendMessage(lookup.bot.chatId, text);
  } catch (err) {
    console.error("[quo-browser] сигнал о выходе из аккаунта не ушёл:", err instanceof Error ? err.message : String(err));
  }
}
