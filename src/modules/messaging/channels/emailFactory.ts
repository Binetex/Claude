import "server-only";
/**
 * EMAIL-канал правил автоматизаций — через наш почтовый модуль (Email Factory), тот же, которым
 * пишут клиенту из карточки заказа (решение владельца 29.09.2026: «причём тут Brevo, если мы можем
 * писать через модуль, который у нас есть»). Письмо — тот же текст, что и SMS правила, простым
 * текстом, с адреса магазина; оно ложится в переписку заказа, и ответ клиента приходит туда же.
 *
 * Кому писать, решает сам модуль: в идущую переписку заказа, а если её нет — заказчику из заказа.
 * Цепочки (Flows) остаются на Brevo со своими шаблонами (`email.ts`): это маркетинг, другая история.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { sendOrderEmail } from "@/integrations/emailFactory/send";
import type { ChannelSender, ChannelSendContext, ChannelSendResult } from "./types";

/** Магазин или заказ не готовы к письму — «нельзя отправить», а не сбой: job SKIPPED. */
const SKIP_CODES = new Set([
  "no_customer_email",
  "email_factory_not_configured",
  "no_sending_domain",
  "domain_not_ready",
  "domain_not_selected", // у магазина не выбран домен, а доменов несколько — писать с чужого нельзя
  "empty_text",
  "order_not_found",
]);

export function createEmailFactoryChannelSender(prisma: PrismaClient): ChannelSender {
  return {
    channel: "EMAIL",
    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      const res = await sendOrderEmail(prisma, { orderId: ctx.orderId, text: ctx.text, sendKey: `auto:${ctx.idempotencyKey}`, sentByUserId: null });
      if (res.ok) return { ok: true, providerMessageId: res.messageId };
      return { ok: false, code: res.code, retryable: !!res.retryable, skip: SKIP_CODES.has(res.code) };
    },
  };
}
