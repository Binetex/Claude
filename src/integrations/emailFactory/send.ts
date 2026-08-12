import "server-only";
/**
 * Ручная переписка с клиентом по email из карточки заказа: ответ в существующий тред и первое
 * письмо, когда переписки ещё нет.
 *
 * Куда уходит письмо, решает СЕРВЕР, а не браузер. При ответе — адрес и тред из последнего
 * входящего письма заказа; при первом письме — адрес заказчика из самого заказа. Принимать
 * адресата из формы нельзя: подменой поля можно было бы написать кому угодно от имени магазина.
 *
 * Адрес ОТПРАВИТЕЛЯ мы не задаём вовсе — его определяет домен, подключённый в Email Factory
 * (проверено: `from`/`domain` в теле игнорируются). Значит писать можно только тем магазинам, чей
 * домен там подключён; сегодня подключён один — theflow.la.
 *
 * Идемпотентность — по образцу `sendOrderSms`: строка создаётся ДО вызова провайдера под
 * уникальным `sendKey`. Успешная отправка, оборвавшаяся до записи, иначе оставила бы клиента с
 * письмом, которого нет в карточке, а повтор отправил бы второе. Провалившаяся попытка честно
 * возвращает ошибку, а не «дубликат-успех»: иначе сотрудник решил бы, что клиенту ответили.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveEmailFactoryToken } from "./token";
import { replyToThread, sendNewMessage, type SentMessage, type ClientResult } from "./client";

export const EMAIL_REPLY_MAX_LENGTH = 10_000;

export type SendReplyResult =
  | { ok: true; messageId: string; duplicate?: true }
  | { ok: false; code: string; messageId?: string };

function isP2002(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Тема первого письма. Номер заказа — единственное, что клиент точно узнает в списке писем. */
function firstSubject(orderNumber: string): string {
  return `Заказ ${orderNumber}`;
}

export async function sendOrderEmail(
  prisma: PrismaClient,
  input: { orderId: string; text: string; sendKey: string; sentByUserId: string | null }
): Promise<SendReplyResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, code: "empty_text" };
  if (text.length > EMAIL_REPLY_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!input.sendKey) return { ok: false, code: "missing_idempotency_key" };

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { orderNumber: true, senderEmail: true },
  });
  if (!order) return { ok: false, code: "order_not_found" };

  // Переписка уже идёт — отвечаем в её тред, чтобы письмо легло в ту же цепочку у клиента.
  const lastInbound = await prisma.orderEmailMessage.findFirst({
    where: { orderId: input.orderId, direction: "INBOUND", threadId: { not: null } },
    orderBy: { occurredAt: "desc" },
    select: { threadId: true, fromEmail: true, toEmail: true, subject: true },
  });

  // Кому пишем: собеседнику из переписки, а если её нет — заказчику из заказа.
  const toEmail = lastInbound?.fromEmail ?? order.senderEmail ?? "";
  if (!toEmail.includes("@")) return { ok: false, code: "no_customer_email" };

  const token = await resolveEmailFactoryToken(prisma);
  if (!token) return { ok: false, code: "email_factory_not_configured" };

  const subject = lastInbound?.subject ?? firstSubject(order.orderNumber);

  let pendingId: string;
  try {
    const pending = await prisma.orderEmailMessage.create({
      data: {
        orderId: input.orderId,
        threadId: lastInbound?.threadId ?? null,
        direction: "OUTBOUND",
        status: "PENDING",
        // Отправитель проставится доменом Email Factory. До ответа провайдера мы его не знаем,
        // поэтому у первого письма здесь пусто — заполним тем, что вернёт провайдер, если вернёт.
        fromEmail: lastInbound?.toEmail ?? "",
        toEmail,
        subject,
        text,
        occurredAt: new Date(),
        sendKey: input.sendKey,
        sentByUserId: input.sentByUserId,
      },
      select: { id: true },
    });
    pendingId = pending.id;
  } catch (err) {
    if (!isP2002(err)) throw err;
    const existing = await prisma.orderEmailMessage.findUnique({ where: { sendKey: input.sendKey }, select: { id: true, status: true } });
    if (!existing) throw err;
    // Прошлая попытка с ЭТИМ ключом провалилась — письмо не ушло. Молчаливый «успех» заставил бы
    // сотрудника думать, что клиенту ответили. Повтор возможен только с НОВЫМ ключом.
    if (existing.status === "FAILED") return { ok: false, code: "previous_attempt_failed", messageId: existing.id };
    return { ok: true, messageId: existing.id, duplicate: true };
  }

  const res: ClientResult<SentMessage> = lastInbound?.threadId
    ? await replyToThread(token, lastInbound.threadId, text)
    : await sendNewMessage(token, { to: toEmail, subject, text });

  if (!res.ok) {
    await prisma.orderEmailMessage.update({ where: { id: pendingId }, data: { status: "FAILED", errorSafe: res.code } });
    return { ok: false, code: res.code, messageId: pendingId };
  }

  await prisma.orderEmailMessage.update({
    where: { id: pendingId },
    data: {
      status: "SENT",
      providerMessageId: res.data.id,
      // У первого письма тред появляется только сейчас — без него следующий ответ ушёл бы
      // отдельной цепочкой, и клиент увидел бы два несвязанных письма.
      threadId: res.data.threadId ?? lastInbound?.threadId ?? null,
    },
  });
  return { ok: true, messageId: pendingId };
}
