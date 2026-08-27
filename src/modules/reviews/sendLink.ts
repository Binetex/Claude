import "server-only";
/**
 * Отправка клиенту ссылки на отзыв: SMS, а если SMS не смогла — письмо.
 *
 * Своего транспорта здесь нет. SMS уходит тем же `sendOrderSms`, что и ручное сообщение из
 * карточки заказа, письмо — тем же `ChannelSender`, что обслуживает автоматизации. Второй путь
 * наружу означал бы второе место, где чинить отправку.
 *
 * Граница «SMS не смогла» здесь ШИРЕ, чем у автоматизаций, и это осознанно.
 *
 * В рассылках выключенный у магазина QUO означает «не собирались писать», и подменять его почтой
 * нельзя: один снятый флажок разослал бы письма по всем заказам. Здесь же отправка — следствие
 * решения человека по КОНКРЕТНОМУ заказу: оператор нажал кнопку или система дошла до второй
 * неудачной попытки дозвониться. Отказать словами «SMS у магазина выключены» значит оставить
 * его без единого способа отправить ссылку, хотя почта настроена.
 *
 * Не пробуем почту только там, где сломано само сообщение (пустой текст, длина, потерянный
 * заказ): письмо собирается из СВОЕГО шаблона и отправило бы другой текст, спрятав ошибку.
 *
 * Ссылка берётся ИЗ СНИМКА запроса, а не подбирается заново: между созданием запроса и звонком
 * владелец мог переразметить ZIP, а клиенту надо отправить ровно ту точку, которую оператор
 * видит на экране.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms } from "@/integrations/quo/send";
import { createEmailChannelSender } from "@/modules/automations/channels/email";
import { buildOrderVariables } from "@/modules/automations/variables";
import { renderTemplate } from "@/modules/automations/template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "@/modules/automations/orderSource";
import { resolveCustomerEmail } from "@/modules/automations/emailAudience";
import { recordLinkSent, recordLinkFailed, type RequestActor } from "./requests";

/**
 * Тексты по умолчанию. Магазин может задать свои в настройках модуля.
 *
 * ПО-АНГЛИЙСКИ: это сообщения КЛИЕНТУ, а клиенты у всех магазинов американские. Русский здесь
 * язык интерфейса владельца и оператора, но не язык переписки с покупателем.
 *
 * Переменные — только из `SMS_VARIABLES`. Неизвестное имя рендер молча заменяет пустой строкой,
 * поэтому опечатка в переменной не падает, а тихо съедает часть текста: клиент получил бы
 * сообщение, начинающееся с запятой.
 */
export const DEFAULT_ASK_SMS =
  "Hi {{sender_name}}, thank you for your order with {{store_name}}! If you were happy with it, would you mind leaving us a quick review? {{review_url}}";

export const DEFAULT_REMINDER_SMS =
  "Hi {{sender_name}}, a gentle reminder about the review you kindly promised — it only takes a minute: {{review_url}}";

export type SendLinkKind = "ASK" | "REMINDER";

export type SendLinkResult =
  | { ok: true; channel: "SMS" | "EMAIL" }
  | { ok: false; code: string; error: string };

/**
 * Коды, при которых почта НЕ пробуется: испорчено само сообщение, а не канал. Всё остальное —
 * включая выключенный у магазина QUO — повод отправить письмо, потому что человек уже решил,
 * что этому клиенту пишем. Список — противоположность `SMS_UNAVAILABLE_CODES` у автоматизаций
 * и намеренно не совпадает с ним: там правило про массовую рассылку, здесь про один заказ.
 */
const BROKEN_MESSAGE_CODES = new Set([
  "empty_text",
  "too_long",
  "order_not_found",
  "missing_idempotency_key",
  "previous_attempt_failed",
]);

const ERRORS: Record<string, string> = {
  no_review_url: "У заказа нет ссылки на отзыв: заведите точку для этого магазина или задайте запасную.",
  request_not_found: "Запрос не найден.",
  no_customer_contact: "У заказчика нет ни телефона, ни email — отправить нечем.",
  email_not_configured: "SMS не ушла, а письмо отправить нечем: у магазина не настроен Email.",
  store_quo_disabled: "SMS у магазина выключены, а письмо отправить нечем: не настроен Email.",
  quo_not_configured: "SMS недоступны, а письмо отправить нечем: не настроен Email.",
};

function humanize(code: string): string {
  return ERRORS[code] ?? `Не удалось отправить (${code}).`;
}

/**
 * `sendKey` задаётся снаружи и обязан быть НОВЫМ на каждую попытку: ключ одноразовый, и после
 * неудачи повтор с тем же ключом вернул бы «уже отправлено» вместо новой отправки.
 */
export async function sendReviewLink(
  db: PrismaClient,
  input: { requestId: string; kind: SendLinkKind; sendKey: string; actor: RequestActor }
): Promise<SendLinkResult> {
  const request = await db.orderReviewRequest.findUnique({
    where: { id: input.requestId },
    select: { id: true, orderId: true, reviewUrlSnapshot: true },
  });
  if (!request) return { ok: false, code: "request_not_found", error: humanize("request_not_found") };
  if (!request.reviewUrlSnapshot) return { ok: false, code: "no_review_url", error: humanize("no_review_url") };

  const order = await db.order.findUnique({ where: { id: request.orderId }, include: SMS_ORDER_INCLUDE });
  if (!order) return { ok: false, code: "request_not_found", error: humanize("request_not_found") };

  const settings = await db.siteReviewSettings.findUnique({
    where: { siteId: order.siteId },
    select: { askSmsTemplate: true, askBrevoTemplateId: true, reminderSmsTemplate: true, reminderBrevoTemplateId: true },
  });

  const isAsk = input.kind === "ASK";
  const template = (isAsk ? settings?.askSmsTemplate : settings?.reminderSmsTemplate) || (isAsk ? DEFAULT_ASK_SMS : DEFAULT_REMINDER_SMS);
  const brevoTemplateId = (isAsk ? settings?.askBrevoTemplateId : settings?.reminderBrevoTemplateId) ?? null;

  // review_url подставляем из снимка: переменная магазина указывала бы на общую ссылку, а не
  // на точку, выбранную для этого адреса.
  const vars = { ...buildOrderVariables(orderToVariableSource(order)), review_url: request.reviewUrlSnapshot };
  const text = renderTemplate(template, vars).text;

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
  const sms = await sendOrderSms(db, client, {
    orderId: request.orderId,
    target: "CUSTOMER",
    text,
    idempotencyKey: input.sendKey,
    sentByUserId: input.actor?.userId ?? null,
  });

  if (sms.ok) return { ok: true, channel: "SMS" };

  // Сломано само сообщение — почта его не спасёт и отправила бы другой текст.
  if (BROKEN_MESSAGE_CODES.has(sms.code)) {
    return { ok: false, code: sms.code, error: humanize(sms.code) };
  }

  const email = resolveCustomerEmail(order);
  if (!email.ok) return { ok: false, code: "no_customer_contact", error: humanize("no_customer_contact") };

  const sender = createEmailChannelSender(db);
  const res = await sender.send({
    prisma: db,
    orderId: request.orderId,
    siteId: order.siteId,
    recipientType: "CUSTOMER",
    phoneNormalized: null,
    emailNormalized: email.recipient.emailNormalized,
    triggerType: "REVIEW_REQUEST",
    emailTemplateIdOverride: brevoTemplateId,
    text,
    vars,
    idempotencyKey: `${input.sendKey}:email`,
  });

  if (res.ok) return { ok: true, channel: "EMAIL" };
  return { ok: false, code: res.code, error: humanize(res.code) };
}

/**
 * Отправить и сразу записать исход в воронку. Единственный путь, которым пользуются экран
 * оператора и автоматика: отправка без записи оставила бы клиента с сообщением, которого нет
 * в журнале, а запись без отправки — наоборот.
 */
export async function sendReviewLinkAndRecord(
  db: PrismaClient,
  input: { requestId: string; kind: SendLinkKind; sendKey: string; actor: RequestActor }
): Promise<SendLinkResult> {
  const res = await sendReviewLink(db, input);
  if (res.ok) await recordLinkSent(db, input.requestId, res.channel, input.actor);
  else await recordLinkFailed(db, input.requestId, res.code, input.actor);
  return res;
}
