import "server-only";
/**
 * Купон за отзыв: один код на все магазины.
 *
 * ЗАЧЕМ. Клиент обещал отзыв — следующим шагом ему уходит вознаграждение, и об этом шаге легко
 * забыть: он живёт в голове оператора, а не на экране. Теперь код лежит в настройках, а на
 * запросе видно, отправляли купон или ещё нет.
 *
 * Своего транспорта нет: SMS уходит тем же `sendOrderSms`, что ссылка на отзыв и ручное
 * сообщение из карточки заказа. Второй путь наружу означал бы второе место, где чинить отправку.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms } from "@/integrations/quo/send";
import { buildOrderVariables } from "@/modules/messaging/variables";
import { renderTemplate } from "@/modules/messaging/template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "@/modules/messaging/orderSource";
import { describeSendFailure } from "@/lib/smsFailure";

const SINGLETON = "singleton";

/**
 * Текст по умолчанию — ПО-АНГЛИЙСКИ: это сообщение клиенту. `{{coupon_code}}` подставляется
 * здесь же, остальные переменные — обычные переменные заказа.
 */
export const DEFAULT_COUPON_SMS =
  "Thank you for your review! Here is $20 off your next order at {{store_name}}: use code {{coupon_code}} at checkout.";

export type ReviewRewardView = { couponCode: string; couponSms: string; updatedAt: string | null };

export async function loadReviewReward(prisma: PrismaClient): Promise<ReviewRewardView> {
  const s = await prisma.reviewRewardSettings.findUnique({ where: { id: SINGLETON } });
  return {
    couponCode: s?.couponCode ?? "",
    couponSms: s?.couponSms ?? "",
    updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

export async function saveReviewReward(
  prisma: PrismaClient,
  input: { couponCode: string; couponSms: string }
): Promise<void> {
  const data = { couponCode: input.couponCode.trim() || null, couponSms: input.couponSms.trim() || null };
  await prisma.reviewRewardSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    update: data,
  });
}

export type SendCouponResult = { ok: true } | { ok: false; error: string };

/**
 * Отправляет клиенту купон и запоминает это НА ЗАПРОСЕ (`couponSentAt` + снимок кода).
 *
 * Ключ отправки включает код: сменили купон — можно отправить новый, а двойное нажатие с тем же
 * кодом второго сообщения не создаст.
 */
export async function sendReviewCoupon(
  prisma: PrismaClient,
  input: { requestId: string; actorUserId?: string | null }
): Promise<SendCouponResult> {
  const reward = await loadReviewReward(prisma);
  if (!reward.couponCode) {
    return { ok: false, error: "Купон не задан: впишите код в «Отзывы → Сообщения»." };
  }

  const request = await prisma.orderReviewRequest.findUnique({
    where: { id: input.requestId },
    select: { id: true, orderId: true, couponSentAt: true, couponCodeSnapshot: true },
  });
  if (!request) return { ok: false, error: "Запрос не найден." };
  if (request.couponSentAt && request.couponCodeSnapshot === reward.couponCode) {
    return { ok: false, error: "Этот купон клиенту уже отправлен." };
  }

  const order = await prisma.order.findUnique({ where: { id: request.orderId }, include: SMS_ORDER_INCLUDE });
  if (!order) return { ok: false, error: "Заказ не найден." };

  const vars = { ...buildOrderVariables(orderToVariableSource(order)), coupon_code: reward.couponCode };
  const text = renderTemplate(reward.couponSms || DEFAULT_COUPON_SMS, vars).text;

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
  const sms = await sendOrderSms(prisma, client, {
    orderId: request.orderId,
    target: "CUSTOMER",
    text,
    idempotencyKey: `review-coupon:${request.id}:${reward.couponCode}`,
    sentByUserId: input.actorUserId ?? null,
  });
  if (!sms.ok) return { ok: false, error: describeSendFailure(sms.code, sms.detail) };

  await prisma.orderReviewRequest.update({
    where: { id: request.id },
    data: { couponSentAt: new Date(), couponCodeSnapshot: reward.couponCode },
  });
  return { ok: true };
}
