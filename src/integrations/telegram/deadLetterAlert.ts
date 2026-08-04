import "server-only";
/**
 * Сигнал владельцу о безвозвратно потерянном событии очереди.
 *
 * ЗАЧЕМ. DEAD_LETTER не сообщал никуда. 3 августа 2026 из-за этого 36 авто-SMS умерли молча:
 * публикация событий продолжала работать, обработчик отсутствовал, и заметили это только
 * через сутки — по жалобе на неотправленные сообщения.
 *
 * Идёт НЕ через реестр Telegram-уведомлений: тот завязан на заказ (loadOrderSnapshot,
 * дедуп по orderId), а умереть может событие, к заказу отношения не имеющее. Поэтому шлём
 * напрямую ботом владельца — коротким техническим сообщением.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";
import { resolveOwnerBot } from "./bots";
import { TelegramSender } from "./sender";
import { isTelegramGloballyEnabled } from "./config";
import { TELEGRAM_NOTIFY_EVENT } from "./events";

/** Не чаще одного сообщения на тип события в этот период. */
const THROTTLE_MS = 60 * 60_000;

/**
 * Троттлинг в памяти процесса, а не в БД: массовая смерть событий — это всегда ОДНА причина,
 * и владельцу нужно одно сообщение, а не пятьдесят. Сброс при перезапуске воркера уместен:
 * перезапуск обычно и есть попытка починки, после неё повторный сигнал полезен.
 */
const lastSentAt = new Map<string, number>();

export function buildDeadLetterAlert(prisma: PrismaClient) {
  return async (record: OutboxRecord, err: unknown): Promise<void> => {
    // Сообщение о смерти сообщения — прямой путь к лавине. Про себя не уведомляем.
    if (record.eventType === TELEGRAM_NOTIFY_EVENT) return;

    const now = Date.now();
    const prev = lastSentAt.get(record.eventType);
    if (prev != null && now - prev < THROTTLE_MS) return;

    if (!(await isTelegramGloballyEnabled(prisma))) return;
    const lookup = await resolveOwnerBot(prisma);
    if (!("bot" in lookup)) return;

    const reason = err instanceof Error ? err.message : String(err);
    const text = [
      "⚠️ Событие потеряно (dead-letter)",
      "",
      `Тип: ${record.eventType}`,
      `Объект: ${record.aggregateType} ${record.aggregateId}`,
      `Причина: ${reason}`.slice(0, 300),
      "",
      "Повторных попыток не будет. Другие события того же типа за ближайший час не повторят это сообщение.",
    ].join("\n");

    lastSentAt.set(record.eventType, now);
    await new TelegramSender(lookup.bot.token).sendMessage(lookup.bot.chatId, text);
  };
}

/** Только для тестов: сбросить окно троттлинга. */
export function __resetDeadLetterThrottle(): void {
  lastSentAt.clear();
}
