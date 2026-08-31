import "server-only";
/**
 * Ручная переписка с клиентом по email из карточки заказа: ответ в существующий тред и первое
 * письмо, когда переписки ещё нет.
 *
 * Куда уходит письмо, решает СЕРВЕР, а не браузер. При ответе — адрес и тред из последнего
 * входящего письма заказа; при первом письме — адрес заказчика из самого заказа. Принимать
 * адресата из формы нельзя: подменой поля можно было бы написать кому угодно от имени магазина.
 *
 * Отправляющий домен ОБЯЗАТЕЛЕН для первого письма и берётся из самого Email Factory. Список
 * доменов спрашиваем при отправке, а не храним у себя настройкой: подключение домена делается на
 * его стороне, и наша копия молча разъехалась бы с правдой. Когда домен один — берём его; когда
 * несколько — тот, что совпадает с адресом отправителя магазина в настройках Email.
 *
 * Идемпотентность — по образцу `sendOrderSms`: строка создаётся ДО вызова провайдера под
 * уникальным `sendKey`. Успешная отправка, оборвавшаяся до записи, иначе оставила бы клиента с
 * письмом, которого нет в карточке, а повтор отправил бы второе. Провалившаяся попытка честно
 * возвращает ошибку, а не «дубликат-успех»: иначе сотрудник решил бы, что клиенту ответили.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveEmailFactoryToken } from "./token";
import { replyToThread, sendNewMessage, listDomains, type SentMessage, type ClientResult } from "./client";
import { isP2002 } from "@/lib/prismaErrors";

export const EMAIL_REPLY_MAX_LENGTH = 10_000;

export type SendReplyResult =
  | { ok: true; messageId: string; duplicate?: true }
  | { ok: false; code: string; messageId?: string };

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
    select: { orderNumber: true, senderEmail: true, site: { select: { emailFactoryDomain: true } } },
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

  let res: ClientResult<SentMessage>;
  let sentFromAddress: string | null = null;
  if (lastInbound?.threadId) {
    // Ответ идёт в тред — домен там уже определён, повторно его называть не нужно.
    res = await replyToThread(token, lastInbound.threadId, text);
  } else {
    const domain = await resolveSendingDomain(token, order.site?.emailFactoryDomain ?? null);
    if (!domain.ok) {
      await prisma.orderEmailMessage.update({ where: { id: pendingId }, data: { status: "FAILED", errorSafe: domain.code } });
      return { ok: false, code: domain.code, messageId: pendingId };
    }
    res = await sendNewMessage(token, { to: toEmail, subject, text, domain: domain.domain });
    // Теперь домен известен — дописываем адрес отправителя, иначе у первого письма он навсегда
    // остался бы пустым, и «с какого адреса мы писали этому клиенту» было бы не восстановить.
    sentFromAddress = domain.email;
  }

  if (!res.ok) {
    // Текст провайдера кладём рядом с кодом: он и объясняет, чего не хватило.
    const safe = [res.code, res.detail].filter(Boolean).join(": ").slice(0, 250);
    await prisma.orderEmailMessage.update({ where: { id: pendingId }, data: { status: "FAILED", errorSafe: safe } });
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
      ...(sentFromAddress ? { fromEmail: sentFromAddress } : {}),
    },
  });
  return { ok: true, messageId: pendingId };
}

/**
 * Домен, от имени которого уходит первое письмо.
 *
 * Выбранный в настройках магазина — главный источник. Он ПЕРЕПРОВЕРЯЕТСЯ по живому списку: домен
 * могли отключить в Email Factory уже после выбора, и отправка с него молча провалилась бы на их
 * стороне. Если выбора нет, а домен в аккаунте ровно один — берём его: заводить настройку ради
 * единственного варианта незачем. Во всех остальных случаях честная ошибка, а не случайный выбор:
 * промах отправил бы письмо про заказ одного магазина с адреса другого.
 */
async function resolveSendingDomain(
  token: string,
  siteDomain: string | null
): Promise<{ ok: true; domain: string; email: string } | { ok: false; code: string }> {
  const res = await listDomains(token);
  if (!res.ok) return { ok: false, code: res.code };
  const ready = res.data.filter((d) => d.status.toUpperCase() === "READY");
  if (ready.length === 0) return { ok: false, code: "no_sending_domain" };

  if (siteDomain) {
    const chosen = ready.find((d) => d.domain.toLowerCase() === siteDomain.toLowerCase());
    return chosen ? { ok: true, domain: chosen.domain, email: chosen.email } : { ok: false, code: "domain_not_ready" };
  }
  if (ready.length === 1) return { ok: true, domain: ready[0].domain, email: ready[0].email };
  return { ok: false, code: "domain_not_selected" };
}
