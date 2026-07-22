import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { getTelegramConfig, resolveChatId } from "./config";
import { getTelegramEvent } from "./registry";
import { TelegramSender } from "./sender";
import { buttonFor, renderFloristMessage, renderOwnerCreated, renderOwnerDeliveryProblem, renderOwnerPaymentProblem, type OrderSnapshot } from "./templates";
import type { TelegramNotifyPayload } from "./events";

/**
 * Единый обработчик ВСЕХ внутренних Telegram-уведомлений: тип события → запись реестра →
 * текст → отправка или редактирование. Новый тип уведомления не требует нового обработчика.
 *
 * Гарантии:
 *  - не настроен токен/чат → событие пропускается с безопасной причиной, worker не падает;
 *  - существующее сообщение с тем же dedupeKey → editMessage вместо дубля;
 *  - текст не изменился → в Telegram не ходим вовсе;
 *  - сообщение нельзя отредактировать (удалено) → отправляем новое и обновляем messageId;
 *  - временная ошибка Telegram → throw, чтобы outbox повторил с backoff;
 *  - постоянная ошибка → лог и выход без падения worker'а.
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

    const cfg = getTelegramConfig();
    const chat = resolveChatId(cfg, def.audience);
    if ("skip" in chat) {
      // Осознанно выключенная интеграция — штатный no-op (аварийный выключатель).
      if (chat.skip === "telegram_disabled") {
        console.info(`[telegram] ${p.type} пропущено: интеграция выключена`);
        return;
      }
      // Включена, но НЕ настроена — уведомление молча терять нельзя. Бросаем: outbox
      // повторит с backoff, а при исчерпании попыток событие станет видимым в dead-letter,
      // а не исчезнет как «успешно обработанное».
      throw new Error(`telegram_not_configured:${chat.skip}`);
    }

    const order = await loadOrderSnapshot(prisma, p.orderId);
    if (!order) return; // заказ исчез — уведомлять не о чем

    const ctx = p.context ?? {};
    const text = renderFor(p.type, order, ctx);
    const button = buttonFor(p.type, order.id);
    const dedupeKey = def.dedupeKey(order.id);

    const existing = await prisma.telegramMessage.findUnique({ where: { dedupeKey } });
    const sender = new TelegramSender(cfg!.botToken);

    if (existing) {
      // Текст не изменился — в Telegram не ходим (иначе получили бы 400 "not modified").
      if (existing.lastText === text) return;
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
      // Сообщение удалено/нередактируемо — отправляем новое вместо него.
    }

    const sent = await sender.sendMessage(chat.chatId, text, button);
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
        chatId: chat.chatId,
        messageId: sent.messageId,
        orderId: order.id,
        eventType: p.type,
        lastText: text,
      },
      update: { chatId: chat.chatId, messageId: sent.messageId, lastText: text, eventType: p.type },
    });
  };
}

function renderFor(type: TelegramNotifyPayload["type"], order: OrderSnapshot, ctx: Record<string, string | null>): string {
  switch (type) {
    case "order.assigned":
      return renderFloristMessage(order, { floristName: ctx.floristName ?? null });
    case "order.reassigned":
      return renderFloristMessage(order, { reassigned: true, floristName: ctx.floristName ?? null });
    case "order.created":
      return renderOwnerCreated(order, ctx.paymentLabel ?? "—");
    case "payment.pending":
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
