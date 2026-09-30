import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import type { TelegramEventType } from "./registry";

/** Единственный тип outbox-события для всех внутренних Telegram-уведомлений. */
export const TELEGRAM_NOTIFY_EVENT = "telegram.notify";

export type TelegramNotifyPayload = {
  type: TelegramEventType;
  orderId: string;
  /** Для событий флориста: чей персональный бот отправляет и в чей чат. */
  floristId?: string | null;
  /** Доп. контекст под конкретный тип (имя флориста, статус доставки, причина) — без PII сверх нужного. */
  context?: Record<string, string | null>;
};

/**
 * Публикует уведомление в durable outbox. Идемпотентность на уровне очереди: один и тот же
 * `occurrenceKey` не создаёт второе событие (повторный webhook/sync безопасен). Вторая линия
 * защиты — unique dedupeKey в TelegramMessage: даже если событие продублируется, обработчик
 * отредактирует существующее сообщение, а не отправит новое.
 *
 * `occurrenceKey` уходит и в `context.occurrence`, если его не задали явно: из него реестр строит
 * ключ сообщения у событий «каждый случай — новое сообщение» (перенос, ответ на письмо). Без этого
 * второй перенос одного заказа молча правил первое сообщение, и его никто не видел (до 30.09.2026).
 * Типам, чей ключ случая не учитывает (карточка назначения), это ничего не меняет.
 *
 * Best-effort: сбой публикации логируется и НЕ ломает бизнес-операцию (назначение, приём заказа).
 */
export async function publishTelegramNotification(
  prisma: PrismaClient,
  p: TelegramNotifyPayload & { occurrenceKey: string }
): Promise<void> {
  try {
    const repo = new PrismaOutboxRepository(prisma);
    await repo.enqueue({
      eventType: TELEGRAM_NOTIFY_EVENT,
      aggregateType: "order",
      aggregateId: p.orderId,
      payload: {
        type: p.type,
        orderId: p.orderId,
        floristId: p.floristId ?? null,
        context: { ...p.context, occurrence: p.context?.occurrence ?? p.occurrenceKey },
      },
      idempotencyKey: `telegram:${p.type}:${p.occurrenceKey}`,
    });
  } catch (err) {
    console.error(`[telegram] publish ${p.type} failed for order ${p.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}
