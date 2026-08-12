import "server-only";
/**
 * Ручной ответ клиенту по email из карточки заказа. Только ОТВЕТ в существующий тред: письмо
 * первым мы не пишем — переписку начинает клиент, а транзакционные письма шлёт Brevo.
 *
 * Идемпотентность — по образцу `sendOrderSms`: строка создаётся ДО вызова провайдера под
 * уникальным `sendKey`. Успешная отправка, оборвавшаяся до записи, иначе оставила бы клиента с
 * письмом, которого нет в карточке, а повтор отправил бы второе. Провалившаяся попытка честно
 * возвращает ошибку, а не «дубликат-успех»: иначе сотрудник решил бы, что клиенту ответили.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveEmailFactoryToken } from "./token";
import { replyToThread } from "./client";

export const EMAIL_REPLY_MAX_LENGTH = 10_000;

export type SendReplyResult =
  | { ok: true; messageId: string; duplicate?: true }
  | { ok: false; code: string; messageId?: string };

function isP2002(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * `threadId` берётся из ПОСЛЕДНЕГО входящего письма заказа, а не передаётся из браузера: иначе
 * ответ можно было бы отправить в чужой тред, подменив значение в запросе.
 */
export async function sendOrderEmailReply(
  prisma: PrismaClient,
  input: { orderId: string; text: string; sendKey: string; sentByUserId: string | null }
): Promise<SendReplyResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, code: "empty_text" };
  if (text.length > EMAIL_REPLY_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!input.sendKey) return { ok: false, code: "missing_idempotency_key" };

  const last = await prisma.orderEmailMessage.findFirst({
    where: { orderId: input.orderId, direction: "INBOUND", threadId: { not: null } },
    orderBy: { occurredAt: "desc" },
    select: { threadId: true, fromEmail: true, toEmail: true, subject: true },
  });
  // Отвечать некому и не во что: тред заводит клиент своим письмом.
  if (!last?.threadId) return { ok: false, code: "no_thread" };

  const token = await resolveEmailFactoryToken(prisma);
  if (!token) return { ok: false, code: "email_factory_not_configured" };

  let pendingId: string;
  try {
    const pending = await prisma.orderEmailMessage.create({
      data: {
        orderId: input.orderId,
        threadId: last.threadId,
        direction: "OUTBOUND",
        status: "PENDING",
        // Наш ответ идёт с того адреса, НА который клиент писал, и ему самому — обратный
        // порядок относительно входящего письма.
        fromEmail: last.toEmail,
        toEmail: last.fromEmail,
        subject: last.subject,
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

  const res = await replyToThread(token, last.threadId, text);
  if (!res.ok) {
    await prisma.orderEmailMessage.update({ where: { id: pendingId }, data: { status: "FAILED", errorSafe: res.code } });
    return { ok: false, code: res.code, messageId: pendingId };
  }

  await prisma.orderEmailMessage.update({
    where: { id: pendingId },
    data: { status: "SENT", providerMessageId: res.data.id },
  });
  return { ok: true, messageId: pendingId };
}
