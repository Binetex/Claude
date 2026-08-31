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

// Временные (повторяемые) коды QUO — повтор с backoff через outbox. `previous_attempt_failed` —
// гонка двух воркеров на одной попытке: ключ per-attempt уже сожжён неудачей, но следующая
// попытка получит новый ключ, поэтому это тоже повторяемо, а не терминальный сбой.
const RETRYABLE_CODES = new Set(["quo_server", "quo_network", "quo_rate_limit", "previous_attempt_failed"]);
/**
 * Подмножество SKIP_CODES, при котором включается «Email, если SMS недоступно». Граница узкая
 * и проведена по одному вопросу: ХОТЕЛИ ли мы вообще отправить это SMS.
 *
 * Здесь — «хотели, но физически не смогли»: телефон непригоден, у магазина нет номера-отправителя
 * при включённом QUO. Такое молчание и есть та дыра, ради которой настройка существует.
 *
 * Здесь НЕТ `store_quo_disabled` и `quo_not_configured`: выключенный QUO — это решение владельца
 * «этот магазин не шлёт SMS», а не сбой. Подменять его рассылкой писем нельзя — выключение канала
 * превратилось бы в смену канала, и один снятый флажок разослал бы почту по всем заказам магазина.
 *
 * Здесь НЕТ `too_long`, `empty_text`, `order_not_found`, `missing_idempotency_key`: это поломка
 * шаблона или вызова. Письмо Brevo собирается из СВОЕГО шаблона, а не из текста SMS, поэтому
 * fallback отправил бы другое сообщение и спрятал ошибку вместо того, чтобы её показать.
 *
 * Ошибки самого QUO (`quo_client`, `quo_server`, …) сюда не входят по построению: они не skip, а
 * сбой отправки, и до fallback доходят через терминальный FAILED.
 */
export const SMS_UNAVAILABLE_CODES = new Set([
  "invalid_target_phone", // телефон непригоден (нет, мусор, не парсится в E.164)
  "store_no_quo_number", // QUO включён, но номера-отправителя нет — настройка сломана, не выключена
]);

// Config/precondition-коды: не сбой отправки, а «нельзя отправить» → job SKIPPED (не FAILED).
const SKIP_CODES = new Set([
  ...SMS_UNAVAILABLE_CODES,
  "store_quo_disabled",
  "quo_not_configured",
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
