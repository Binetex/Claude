import "server-only";
/**
 * SMS-канал: реализация ChannelSender поверх СУЩЕСТВУЮЩЕГО sendOrderSms (QUO, номер Site,
 * запись OrderCommunication). QUO-интеграция НЕ переписывается. Идемпотентность отправки —
 * по ctx.idempotencyKey (движок формирует его per-attempt). Гейтинг (quoEnabled/номер Site)
 * выполняется внутри sendOrderSms и мапится в skip-код (config-проблема, не сбой).
 */
import type { QuoClient } from "@/integrations/quo/client";
import { sendOrderSms, type SendTarget } from "@/integrations/quo/send";
import type { ChannelSender, ChannelSendContext, ChannelSendResult } from "./types";

// Временные (повторяемые) коды QUO — повтор с backoff через outbox.
const RETRYABLE_CODES = new Set(["quo_server", "quo_network", "quo_rate_limit"]);
// Config/precondition-коды: не сбой отправки, а «нельзя отправить» → job SKIPPED (не FAILED).
const SKIP_CODES = new Set([
  "store_no_quo_number",
  "store_quo_disabled",
  "quo_not_configured",
  "invalid_target_phone",
  "empty_text",
  "too_long",
  "order_not_found",
  "missing_idempotency_key",
]);

export function createSmsChannelSender(getClient: () => QuoClient | null): ChannelSender {
  return {
    channel: "SMS",
    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      const client = getClient();
      const res = await sendOrderSms(ctx.prisma, client, {
        orderId: ctx.orderId,
        target: ctx.recipientType as SendTarget,
        text: ctx.text,
        idempotencyKey: ctx.idempotencyKey,
        sentByUserId: null,
      });
      if (res.ok) {
        let providerMessageId: string | null = null;
        if (res.communicationId) {
          const comm = await ctx.prisma.orderCommunication.findUnique({
            where: { id: res.communicationId },
            select: { providerResourceId: true },
          });
          providerMessageId = comm?.providerResourceId ?? null;
        }
        return { ok: true, communicationId: res.communicationId ?? null, providerMessageId };
      }
      return { ok: false, code: res.code, retryable: RETRYABLE_CODES.has(res.code), skip: SKIP_CODES.has(res.code) };
    },
  };
}
