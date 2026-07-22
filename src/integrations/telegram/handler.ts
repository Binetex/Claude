import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { getTelegramEvent } from "./registry";
import { resolveOwnerBot, resolveFloristBot, resolveBotById, type BotLookup, type ResolvedBot } from "./bots";
import { isTelegramGloballyEnabled } from "./config";
import { TelegramSender } from "./sender";
import {
  buttonFor,
  renderFloristMessage,
  renderFloristHandedOver,
  renderOwnerCreated,
  renderOwnerDeliveryProblem,
  renderOwnerPaymentProblem,
  type OrderSnapshot,
} from "./templates";
import type { TelegramNotifyPayload } from "./events";

/**
 * Единый обработчик ВСЕХ внутренних Telegram-уведомлений: тип события → запись реестра →
 * бот → текст → отправка или редактирование. Новый тип не требует нового обработчика.
 *
 * Ключевое отличие от общего бота: сообщение редактируется ТЕМ ЖЕ ботом, который его отправил
 * (Telegram не позволяет иначе). Поэтому TelegramMessage хранит botId, и при редактировании
 * берётся токен именно этого бота, а не текущий бот флориста.
 *
 * Гарантии:
 *  - глобальный выключатель — штатный no-op;
 *  - у флориста нет бота / бот выключен → тихий пропуск (решение владельца);
 *  - настройка сломана (не расшифровывается токен) → throw, чтобы это стало видно;
 *  - временная ошибка Telegram → throw, outbox повторит с backoff;
 *  - текст не изменился → в Telegram не ходим вовсе;
 *  - сообщение удалено → отправляем новое и обновляем messageId.
 */
export function buildTelegramNotifyHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as TelegramNotifyPayload;
    if (!p?.type || !p?.orderId) return;

    const def = getTelegramEvent(p.type);
    if (!def) {
      console.warn(`[telegram] неизвестный тип события ${p.type} — пропуск`);
      return;
    }

    if (!(await isTelegramGloballyEnabled(prisma))) {
      console.info(`[telegram] ${p.type} пропущено: уведомления выключены`);
      return;
    }

    if (def.perFlorist && !p.floristId) {
      console.warn(`[telegram] ${p.type} без floristId — пропуск`);
      return;
    }

    const order = await loadOrderSnapshot(prisma, p.orderId);
    if (!order) return; // заказ исчез — уведомлять не о чем

    const ctx = p.context ?? {};
    const dedupeKey = def.dedupeKey({ orderId: order.id, floristId: p.floristId });
    const existing = await prisma.telegramMessage.findUnique({ where: { dedupeKey } });

    // Редактировать может только отправивший бот, поэтому для существующего сообщения
    // берём именно его токен, а не текущего бота флориста (тот мог смениться).
    const lookup: BotLookup = existing?.botId
      ? await resolveBotById(prisma, existing.botId)
      : def.perFlorist
        ? await resolveFloristBot(prisma, p.floristId!)
        : await resolveOwnerBot(prisma);

    if ("skip" in lookup) {
      if (lookup.skip === "bad_token_ciphertext") {
        // Поломка настройки (сменился ключ шифрования) — терять молча нельзя.
        throw new Error(`telegram_bot_unusable:${lookup.skip}`);
      }
      console.info(`[telegram] ${p.type} пропущено: ${lookup.skip}`);
      return;
    }

    const bot: ResolvedBot = lookup.bot;
    const text = renderFor(p.type, order, ctx);
    const button = buttonFor(p.type, order.id);
    const sender = new TelegramSender(bot.token);

    if (existing) {
      if (existing.lastText === text) return; // нечего менять
      const edited = await sender.editMessage(existing.chatId, existing.messageId, text, button);
      if (edited.ok) {
        await prisma.telegramMessage.update({ where: { dedupeKey }, data: { lastText: text, eventType: p.type } });
        return;
      }
      if (!edited.needsResend) {
        if (edited.retryable) throw new Error(`telegram_edit_transient:${edited.code}`);
        console.error(`[telegram] edit ${p.type} order ${order.id} не удалось: ${edited.code}`);
        return;
      }
      // Сообщение удалено/нередактируемо — отправим новое вместо него.
    }

    const sent = await sender.sendMessage(bot.chatId, text, button);
    if (!sent.ok) {
      if (sent.retryable) throw new Error(`telegram_send_transient:${sent.code}`);
      console.error(`[telegram] send ${p.type} order ${order.id} не удалось: ${sent.code}`);
      return;
    }

    await prisma.telegramMessage.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        audience: def.audience,
        chatId: bot.chatId,
        messageId: sent.messageId,
        botId: bot.id,
        orderId: order.id,
        eventType: p.type,
        lastText: text,
      },
      update: { chatId: bot.chatId, messageId: sent.messageId, botId: bot.id, lastText: text, eventType: p.type },
    });
  };
}

function renderFor(type: TelegramNotifyPayload["type"], order: OrderSnapshot, ctx: Record<string, string | null>): string {
  switch (type) {
    case "order.assigned":
      return renderFloristMessage(order, { floristName: ctx.floristName ?? null });
    case "order.handed_over":
      return renderFloristHandedOver(order, ctx.toFloristName ?? null);
    case "order.created":
      return renderOwnerCreated(order, ctx.paymentLabel ?? "—");
    case "payment.failed":
      return renderOwnerPaymentProblem(order, ctx.safeReason ?? "требуется проверка оплаты");
    case "delivery.problem":
      return renderOwnerDeliveryProblem(order, ctx.status ?? "PROBLEM", ctx.safeReason ?? null);
  }
}

async function loadOrderSnapshot(prisma: PrismaClient, orderId: string): Promise<OrderSnapshot | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, deliveryDate: true, deliveryWindow: true,
      recipientName: true, addressLine: true, apartment: true, city: true, zip: true,
      cardMessage: true, deliveryInstructions: true,
      site: { select: { name: true } },
      items: { select: { name: true, variantName: true, quantity: true, floristCompositionSnapshot: true } },
    },
  });
  if (!o) return null;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    siteName: o.site.name,
    deliveryDate: o.deliveryDate,
    deliveryWindow: o.deliveryWindow,
    recipientName: o.recipientName,
    addressLine: o.addressLine,
    apartment: o.apartment,
    city: o.city,
    zip: o.zip,
    cardMessage: o.cardMessage,
    deliveryInstructions: o.deliveryInstructions,
    items: o.items.map((i) => ({ name: i.name, variantName: i.variantName, quantity: i.quantity, composition: i.floristCompositionSnapshot })),
  };
}
