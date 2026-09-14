"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms, type SendTarget } from "@/integrations/quo/send";
import { describeSendFailure } from "@/lib/smsFailure";
import { toE164 } from "@/lib/phone";

type FormState = { ok?: boolean; error?: string; status?: string } | null;

/**
 * Отправка SMS из карточки заказа. Доступна ЛЮБОМУ аутентифицированному сотруднику
 * (requireUser, НЕ OWNER-only). Клиент создаётся БЕЗ авто-ретрая (maxRetries:0). Отправка идёт
 * только при настроенном номере QUO у магазина и включённом QUO_ENABLED.
 */
export async function sendOrderSmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const target = String(formData.get("target") ?? "") as SendTarget;
  const text = String(formData.get("text") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  if (!orderId || (target !== "CUSTOMER" && target !== "RECIPIENT")) return { error: "Некорректный запрос." };

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;

  // «Сюрприз: получателю не пишем» гасит то, что система пишет САМА. Живой ответ на входящее
  // получателя запрещать нельзя: он написал первым, и молчание в ответ хуже раскрытого сюрприза.
  // Проверяем на СЕРВЕРЕ по переписке заказа, а не по флагу из браузера: иначе подменой поля
  // формы запрет обходился бы одним запросом.
  const replyToInbound = target === "RECIPIENT" && (await hasInboundFromRecipient(orderId));

  const res = await sendOrderSms(prisma, client, { orderId, target, text, idempotencyKey, sentByUserId: user.id, replyToInbound });
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (res.ok) return { ok: true, status: res.status };
  // Подписи общие с Telegram-ботом (`lib/smsFailure`): один и тот же отказ обязан читаться
  // одинаково, где бы человек его ни увидел.
  return { error: describeSendFailure(res.code, res.detail) };
}

/**
 * Писал ли получатель нам сам по этому заказу. Сверяем по НОМЕРУ получателя из заказа, а не по
 * сохранённой роли сообщения: роль ставится один раз при приёме и устаревает, когда телефон в
 * заказе исправляют (та же причина, что у commGroupOf в карточке).
 */
async function hasInboundFromRecipient(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { recipientPhone: true } });
  const phone = toE164(order?.recipientPhone ?? null);
  if (!phone) return false;
  const inbound = await prisma.orderCommunication.findFirst({
    where: { orderId, direction: "INBOUND", externalPhoneNormalized: phone },
    select: { id: true },
  });
  return !!inbound;
}
