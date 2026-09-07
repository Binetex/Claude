import "server-only";
/**
 * «У QUO кончились деньги» — сигнал владельцу и признак для баннера в админке.
 *
 * QUO отвечает на отправку 402, когда на аккаунте нет средств. Это не сбой одного сообщения:
 * пока баланс не пополнен, НИ ОДНА SMS клиенту не уходит — ни ответ ассистента, ни уведомление
 * о доставке, ни ссылка на отзыв. Раньше об этом знал только журнал: 7 сентября владелец узнал
 * о пустом балансе, случайно нажав «Отправить» на черновике.
 *
 * Своей таблицы под это НЕТ намеренно: состояние выводится из записей об отправках, как долг
 * флориста из книги. Последняя исходящая попытка упала с 402 и после неё ничего не ушло — деньги
 * кончились; ушло хоть одно сообщение — баланс есть, и баннер гаснет сам, без кнопки «я оплатил».
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveOwnerBot } from "@/integrations/telegram/bots";
import { isTelegramGloballyEnabled, isTelegramAudienceOn } from "@/integrations/telegram/config";
import { TelegramSender } from "@/integrations/telegram/sender";

/** Ответ QUO «нет денег»: 402 Payment Required. */
export function isQuoOutOfMoney(detail: string | null | undefined): boolean {
  return (detail ?? "").startsWith("402");
}

/** Сколько последних исходящих смотрим: дальше это уже история, а не текущее состояние. */
const LOOKBACK = 20;
const LOOKBACK_DAYS = 14;

/** Не чаще раза в сутки: пустой баланс не чинится сам, и второе сообщение ничего не добавит. */
const ALERT_EVERY_HOURS = 24;

export type QuoBalanceAlert = { at: Date };

/**
 * Кончились ли деньги ПРЯМО СЕЙЧАС. Идём от свежих отправок к старым и останавливаемся на первой,
 * которая что-то говорит: успех — значит баланс есть; 402 — значит нет. Прочие отказы (номер не
 * прошёл A2P, кривой телефон) к балансу отношения не имеют и пропускаются.
 */
export async function loadQuoBalanceAlert(prisma: PrismaClient, now: Date = new Date()): Promise<QuoBalanceAlert | null> {
  const rows = await prisma.orderCommunication.findMany({
    where: {
      provider: "QUO",
      direction: "OUTBOUND",
      type: "SMS",
      status: { in: ["FAILED", "SENT", "DELIVERED"] },
      occurredAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000) },
    },
    orderBy: { occurredAt: "desc" },
    take: LOOKBACK,
    select: { status: true, occurredAt: true, rawMetadata: true },
  });

  for (const r of rows) {
    if (r.status !== "FAILED") return null; // после отказа что-то ушло — деньги есть
    if (isQuoOutOfMoney(providerCodeOf(r.rawMetadata))) return { at: r.occurredAt };
  }
  return null;
}

/** Код провайдера из записи об отправке: его кладёт `send.ts` в момент отказа. */
function providerCodeOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).providerCode;
  return typeof v === "string" ? v : null;
}

/**
 * Когда владельцу в последний раз говорили про пустой баланс. В памяти процесса, как у сигнала
 * о мёртвых событиях: журнал отправок для этого не годится — прошлые 402 в нём означают «отказ
 * был», а не «мы об этом сказали», и первый же запуск считал бы себя опоздавшим.
 */
let lastAlertAt: number | null = null;

/** Только для тестов: забыть, что уже говорили. */
export function __resetQuoBalanceAlert(): void {
  lastAlertAt = null;
}

/**
 * Сообщение владельцу «деньги кончились». Best-effort: сбой Telegram не должен ломать отправку,
 * внутри которой мы находимся. Не чаще раза в сутки — пустой баланс сам не чинится.
 */
export async function alertQuoOutOfMoney(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  try {
    if (lastAlertAt != null && now.getTime() - lastAlertAt < ALERT_EVERY_HOURS * 3_600_000) return;

    if (!(await isTelegramGloballyEnabled(prisma))) return;
    if (!(await isTelegramAudienceOn(prisma, "OWNER"))) return;
    const lookup = await resolveOwnerBot(prisma);
    if (!("bot" in lookup)) return;

    lastAlertAt = now.getTime();
    const text = [
      "🛑 <b>QUO: закончились деньги</b>",
      "",
      "Сообщение клиенту не ушло: QUO отклонил отправку с кодом 402 (нет средств на аккаунте).",
      "Пока баланс не пополнен, клиентам не уходит НИ ОДНА SMS — ни ответы ассистента, ни",
      "уведомления о доставке, ни ссылки на отзывы.",
      "",
      "Пополните аккаунт QUO. Следующее такое сообщение придёт не раньше чем через сутки.",
    ].join("\n");
    await new TelegramSender(lookup.bot.token).sendMessage(lookup.bot.chatId, text);
  } catch (err) {
    console.error("[quo] сигнал о пустом балансе не ушёл:", err instanceof Error ? err.message : String(err));
  }
}
