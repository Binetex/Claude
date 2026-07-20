import "server-only";
/**
 * Исходящая отправка SMS через QUO. Жизненный цикл записи OrderCommunication:
 *   PENDING (до вызова QUO) → SENT (успех, сохранён message/conversation id) → DELIVERED (webhook)
 *                                    └→ FAILED (ошибка QUO, безопасный код без секретов)
 * Идемпотентность — durable: уникальный app-level sendKey (двойной клик/повтор формы не создаёт дубль
 * и НЕ отправляет второй раз). Клиент должен быть создан БЕЗ авто-ретрая (maxRetries:0), чтобы не
 * повторять POST при неоднозначной сетевой ошибке (неизвестно, принял ли QUO). PII в логи не пишем.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { QuoClient } from "./client";
import { QuoApiError } from "./errors";
import { toE164 } from "@/lib/phone";
import { maskPhone, quoLog } from "./logging";

export const SMS_MAX_LENGTH = 1600;
export type SendTarget = "CUSTOMER" | "RECIPIENT";

export type SendSmsInput = { orderId: string; target: SendTarget; text: string; idempotencyKey: string; sentByUserId?: string | null };
export type SendSmsResult =
  | { ok: true; communicationId: string; status: "PENDING" | "SENT"; duplicate: boolean }
  | { ok: false; code: string; communicationId?: string };

function isP2002(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

export async function sendOrderSms(prisma: PrismaClient, client: QuoClient | null, input: SendSmsInput): Promise<SendSmsResult> {
  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, code: "empty_text" };
  if (text.length > SMS_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!input.idempotencyKey) return { ok: false, code: "missing_idempotency_key" };

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, senderPhone: true, recipientPhone: true, site: { select: { quoPhoneNumberId: true, quoPhoneNumber: true } } },
  });
  if (!order) return { ok: false, code: "order_not_found" };

  const e164 = toE164(input.target === "CUSTOMER" ? order.senderPhone : order.recipientPhone);
  if (!e164) return { ok: false, code: "invalid_target_phone" };

  const fromId = order.site?.quoPhoneNumberId ?? null;
  if (!fromId) return { ok: false, code: "store_no_quo_number" }; // не отправляем без номера магазина
  if (!client) return { ok: false, code: "quo_not_configured" };

  // Durable идемпотентность: PENDING-запись с уникальным sendKey. P2002 → уже отправляли.
  let pendingId: string;
  try {
    const pending = await prisma.orderCommunication.create({
      data: {
        orderId: order.id, provider: "QUO", type: "SMS", direction: "OUTBOUND",
        partyRole: input.target, status: "PENDING",
        storePhone: order.site?.quoPhoneNumber ?? null, externalPhone: e164, externalPhoneNormalized: e164,
        messageText: text, providerPhoneNumberId: fromId, occurredAt: new Date(),
        sendKey: input.idempotencyKey, sentByUserId: input.sentByUserId ?? null,
      },
      select: { id: true },
    });
    pendingId = pending.id;
  } catch (err) {
    if (isP2002(err)) {
      const existing = await prisma.orderCommunication.findUnique({ where: { sendKey: input.idempotencyKey }, select: { id: true, status: true } });
      if (existing) {
        quoLog("sms.duplicate_request", { communicationId: existing.id });
        return { ok: true, communicationId: existing.id, status: existing.status === "PENDING" ? "PENDING" : "SENT", duplicate: true };
      }
    }
    throw err;
  }

  // Вызов QUO. Клиент без авто-ретрая: неоднозначную сетевую/5xx ошибку не повторяем автоматически.
  try {
    const res = await client.sendMessage({ content: text, from: fromId, to: [e164] });
    await prisma.orderCommunication.update({
      where: { id: pendingId },
      data: { status: "SENT", providerResourceId: res.id, providerConversationId: res.conversationId, providerPhoneNumberId: fromId, occurredAt: new Date() },
    });
    quoLog("sms.sent", { communicationId: pendingId, target: input.target, phone: maskPhone(e164), resourceId: res.id, textLen: text.length });
    return { ok: true, communicationId: pendingId, status: "SENT", duplicate: false };
  } catch (err) {
    const kind = err instanceof QuoApiError ? err.kind : "network";
    const safeCode = err instanceof QuoApiError ? `${err.kind}:${err.status}` : "network:0";
    await prisma.orderCommunication.update({ where: { id: pendingId }, data: { status: "FAILED", rawMetadata: { error: safeCode } } });
    quoLog("sms.failed", { communicationId: pendingId, target: input.target, phone: maskPhone(e164), errorCode: safeCode });
    return { ok: false, code: `quo_${kind}`, communicationId: pendingId };
  }
}
