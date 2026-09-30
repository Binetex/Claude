import "server-only";
/**
 * Ассистент отвечает и на письма клиента (владелец 29.09.2026: «на емейлы тоже сделать, чтобы ИИ
 * отвечал»). Разбор тот же, что у SMS — правила, проверка ответа, режим магазина, черновик в
 * Telegram, перенос по словам клиента, просьба позвонить, очередь дописанных вдогонку сообщений, —
 * другие только вход и выход: письмо из переписки заказа и ответ письмом на него же через наш
 * почтовый модуль (`deliver.ts::sendAssistantReply`).
 *
 * Только письма, привязанные к заказу. Фото у письма ассистент не разбирает. Письмо, на которое он
 * НЕ ответил (выключен, лимиты, «спасибо», автоответ робота, сбой модели) или чей черновик не дошёл
 * до людей, уходит им обычным уведомлением «клиент ответил на письмо» — почту никто не держит
 * открытой.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { emailNewText, emailQuoteForTelegram, isAutoReply } from "@/integrations/emailFactory/ingest";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { SMS_ORDER_INCLUDE } from "@/modules/messaging/orderSource";
import { localClock } from "@/lib/tz";
import { buildMessages, parseReply, agreeFromMin, type HistoryLine } from "./prompt";
import { shouldConsider, decideDelivery, isCallRequest, isSmallTalk, type AssistantMode } from "./policy";
import { loadCatalog, looksLikeShopping } from "./catalog";
import { loadGlobalNote, activeGlobalNoteText } from "./globalNote";
import { mentionsTime } from "./note";
import { mentionsDay } from "./reschedule";
import type { AssistantEmailPayload } from "./events";
import {
  snapshot, deliveredMoment, countReplies, renderPrompt, earliestFor, labelOf, finishTurn,
  recordReadyTime, alertNoBalance, notifyCallRequest, logCallRequestError,
  takeDeferredQueue, BURST_WINDOW_MIN, BURST_MAX,
} from "./handler";

/** Сколько писем переписки показываем модели: живой переписки по заказу больше не бывает. */
const HISTORY_LIMIT = 12;

type InboundEmail = { id: string; orderId: string; fromEmail: string; occurredAt: Date };

export function buildAssistantEmailHandler(prisma: PrismaClient, deps: { client?: DeepseekClient | null; now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as AssistantEmailPayload;
    if (!p?.emailMessageId) return;

    const email = await prisma.orderEmailMessage.findUnique({
      where: { id: p.emailMessageId },
      select: { id: true, orderId: true, direction: true, fromEmail: true, subject: true, text: true, occurredAt: true, providerMessageId: true },
    });
    if (!email || email.direction !== "INBOUND" || !email.orderId) return;
    // Одно письмо — один разбор: повтор обработчика второго ответа не создаёт.
    if (await prisma.aiTurn.findUnique({ where: { emailMessageId: email.id }, select: { id: true } })) return;

    const order = await prisma.order.findUnique({ where: { id: email.orderId }, include: SMS_ORDER_INCLUDE });
    if (!order) return;
    const site = order.site;
    const inbound: InboundEmail = { id: email.id, orderId: order.id, fromEmail: email.fromEmail, occurredAt: email.occurredAt };

    // Человек дописал письма вдогонку: они отложились в пользу этого, и отвечаем на все разом —
    // как на очередь SMS. Человек в Telegram тоже видит все, а не одно последнее.
    const deferred = await loadDeferredEmails(prisma, inbound);
    const text = [...deferred, email].map((m) => emailNewText(m.text)).filter(Boolean).join("\n");

    // Ответа не будет — людям уходит то же уведомление, что и без ассистента.
    const tellPeople = () =>
      publishTelegramNotification(prisma, {
        type: "customer.email_reply",
        orderId: order.id,
        occurrenceKey: email.providerMessageId ?? email.id,
        context: { from: email.fromEmail, subject: email.subject ?? "", quote: emailQuoteForTelegram(deferred.length ? text : email.text) },
      }).catch(() => null);
    const skip = async (reason: string, notify = true) => {
      await prisma.aiTurn.create({
        data: { siteId: site.id, orderId: order.id, emailMessageId: email.id, status: "SKIPPED", source: "none", skipReason: reason },
      });
      if (notify) await tellPeople();
    };

    // Роботам (автоответ «в отпуске», отбойник, no-reply) и нашим же ящикам не отвечаем: они
    // ответят снова, и переписка пойдёт по кругу до потолка ответов. Людям — как обычное письмо.
    if (isAutoReply(email) || (await fromOwnMailbox(prisma, email.fromEmail))) return skip("auto_reply");
    if (!text) return skip("empty_text");

    // Заказчик — если пишет с адреса из заказа. Переносить заказ может только он.
    const isCustomer = !!order.senderEmail && order.senderEmail.trim().toLowerCase() === email.fromEmail.trim().toLowerCase();

    // Просьба позвонить — людям сразу, как у SMS: владельцу и колл-центру, до потолков и модели.
    const callPeople = () =>
      notifyCallRequest(prisma, order, site, {
        id: email.id,
        // Позвонить можно заказчику: его номер в заказе. Номера незнакомого автора письма мы не знаем.
        externalPhone: isCustomer ? order.senderPhone ?? "" : "",
        // Разговор для «один сигнал на два часа» — адрес письма.
        externalPhoneNormalized: email.fromEmail.trim().toLowerCase(),
      }, text, now()).catch(logCallRequestError);
    const callRequested = isCallRequest(text);
    if (callRequested && site.aiMode !== "OFF" && !order.aiDisabled) await callPeople();

    const gate = shouldConsider({
      mode: site.aiMode as AssistantMode,
      orderDisabled: order.aiDisabled,
      orderClosed: order.orderStatus === "CANCELLED",
      deliveredAt: deliveredMoment(order),
      text,
      lastAutomatedAt: null,
      liveTalkAfterIncoming: null,
      ...(await countReplies(prisma, site, order.id, "", now())),
      now: now(),
    });
    if (!gate.ok) return skip(gate.reason);

    // Клиент дописал ещё письмо, пока шла пауза: разбирать будет последнее, оно заберёт это.
    if (await hasNewerEmail(prisma, inbound)) return skip("superseded", false);

    const cfg = await resolveDeepseekConfig(prisma);
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) return skip("model_not_configured");

    const clock = localClock(site.timezone, now());
    const earliestMin = await earliestFor(prisma, order, clock.dateStr, now());
    const globalNote = activeGlobalNoteText(await loadGlobalNote(prisma), now(), site.timezone);
    const messages = buildMessages({
      channel: "email",
      writerName: isCustomer ? order.senderName : null,
      knowledgeBase: site.aiKnowledgeBase,
      order: { ...snapshot(order, site.name, isCustomer ? "CUSTOMER" : "UNKNOWN", clock.dateStr), earliest: labelOf(earliestMin) },
      history: await loadEmailHistory(prisma, order.id, [...deferred.map((d) => d.id), email.id], site.timezone),
      now: clock,
      globalNote,
      incomingText: text,
      catalog: looksLikeShopping(text) ? await loadCatalog(prisma, site.id).catch(() => []) : undefined,
    });

    let raw: string;
    let modelName: string;
    let latencyMs: number;
    try {
      const res = await client.complete(messages);
      raw = res.text;
      modelName = res.model;
      latencyMs = res.latencyMs;
    } catch (err) {
      const code = err instanceof DeepseekError ? err.code : "unknown";
      await prisma.aiTurn.create({
        data: { siteId: site.id, orderId: order.id, emailMessageId: email.id, status: "FAILED", source: "model", skipReason: `model_${code}`, promptText: renderPrompt(messages) },
      });
      if (code === "no_balance") await alertNoBalance(prisma, now()).catch(() => null);
      await tellPeople();
      return;
    }

    let parsed = parseReply(raw, { agreeFromMin: agreeFromMin(earliestMin) });
    if (parsed.intent === "spam" && !parsed.important) {
      await prisma.aiTurn.create({
        data: { siteId: site.id, orderId: order.id, emailMessageId: email.id, status: "SKIPPED", source: "model", intent: "spam", skipReason: "spam", promptText: renderPrompt(messages), responseText: raw, modelName, latencyMs },
      });
      // Письмо уже привязано к заказу — ошибка модели не должна его спрятать: людям как обычно.
      await tellPeople();
      return;
    }

    // Время из письма — в заметку заказа и людям; перенос дня и окна — как у SMS, только от заказчика.
    // Всё это — лишь когда в САМОМ письме есть время, день или число: модель может взять их из истории.
    if (parsed.readyTime && !mentionsTime(text)) parsed = { ...parsed, readyTime: null };
    if (parsed.readyTime && !site.aiDryRun) {
      await recordReadyTime(prisma, order, email.id, parsed.readyTime, text).catch((err) =>
        console.error(`[assistant] заметка о времени по заказу ${order.id} (письмо) не записана:`, err instanceof Error ? err.message : String(err))
      );
    }
    if (parsed.newDeliveryDate && !mentionsDay(text)) parsed = { ...parsed, newDeliveryDate: null };
    if (!mentionsTime(text) && !/\d/.test(text)) parsed = { ...parsed, confirmedFrom: null, confirmedUntil: null };
    // Сам перенос — когда ответ уйдёт (`promisedChange.ts`), и только на то, что заказчик назвал сам.
    const wantsChange = parsed.confirmedFrom != null || parsed.confirmedUntil != null || !!parsed.newDeliveryDate;

    // Перенос просит не заказчик (муж получателя, сама получательница со своего адреса): заказ по
    // его словам не двигаем — иначе любой, кто знает номер заказа, двигал бы чужой оплаченный
    // заказ. Значит, и «привезём завтра» сами не обещаем: ответ — черновиком, решает человек.
    const action = !isCustomer && wantsChange
      ? "draft"
      : decideDelivery({ mode: site.aiMode as AssistantMode, dryRun: site.aiDryRun, hasReply: !!parsed.replyEn, needsHuman: parsed.needsHuman, important: parsed.important });

    const turn = await prisma.aiTurn.create({
      data: {
        siteId: site.id, orderId: order.id, emailMessageId: email.id,
        status: "DRAFT", source: "model", intent: parsed.intent, important: parsed.important,
        needsHuman: parsed.needsHuman || action === "draft",
        replyText: parsed.replyEn || null,
        promptText: renderPrompt(messages), responseText: raw, modelName, latencyMs,
      },
      select: { id: true },
    });
    // Модель разглядела просьбу позвонить там, где слова её не выдали, — добавка к сигналу выше.
    if (!callRequested && parsed.intent === "call_request") await callPeople();
    const reached = await finishTurn(prisma, turn.id, action, site.aiDryRun, deferred.length ? { text, photoUrls: [] } : null);
    // Ни клиенту, ни человеку разбор не дошёл (уведомления ассистента выключены, Telegram молчит):
    // письмо не должно остаться только в карточке.
    if (!reached) await tellPeople();
  };
}

/**
 * Письма этого же человека по заказу, отложенные В ПОЛЬЗУ разбираемого (`superseded`): граница
 * очереди — уже записанные решения, как у SMS (`handler.ts::takeDeferredQueue`).
 */
async function loadDeferredEmails(prisma: PrismaClient, email: InboundEmail): Promise<{ id: string; text: string }[]> {
  const since = new Date(email.occurredAt.getTime() - BURST_WINDOW_MIN * 60_000);
  const rows = await prisma.aiTurn.findMany({
    where: {
      emailMessage: {
        orderId: email.orderId,
        fromEmail: { equals: email.fromEmail, mode: "insensitive" },
        occurredAt: { gte: since, lt: email.occurredAt },
      },
    },
    orderBy: { emailMessage: { occurredAt: "desc" } },
    take: BURST_MAX,
    select: { status: true, skipReason: true, emailMessage: { select: { id: true, text: true } } },
  });
  return takeDeferredQueue(rows).flatMap((r) => (r.emailMessage ? [r.emailMessage] : []));
}

/**
 * Есть ли от этого же человека письмо ПОЗЖЕ разбираемого, на которое стоит отвечать. «Спасибо»,
 * пустое письмо и автоответ не считаются: иначе они отменили бы ответ на сам вопрос, и клиент
 * не получил бы ничего. Письмо другого человека — его отдельный разговор со своим ответом.
 */
async function hasNewerEmail(prisma: PrismaClient, email: InboundEmail): Promise<boolean> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: {
      orderId: email.orderId,
      direction: "INBOUND",
      id: { not: email.id },
      occurredAt: { gt: email.occurredAt },
      fromEmail: { equals: email.fromEmail, mode: "insensitive" },
    },
    select: { fromEmail: true, subject: true, text: true },
    orderBy: { occurredAt: "asc" },
    take: 5,
  });
  return rows.some((r) => {
    const t = emailNewText(r.text);
    return !!t && !isSmallTalk(t) && !isAutoReply(r);
  });
}

/** Письмо с нашего же магазинного ящика (пересылка, проверка): отвечать самим себе — это круг. */
async function fromOwnMailbox(prisma: PrismaClient, fromEmail: string): Promise<boolean> {
  const domain = fromEmail.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  return (await prisma.site.count({ where: { emailFactoryDomain: { equals: domain, mode: "insensitive" } } })) > 0;
}

/** Переписка заказа по почте — от старых к новым, без цитат: модель видит разговор, а не простыни. */
async function loadEmailHistory(prisma: PrismaClient, orderId: string, exceptIds: string[], tz: string | null): Promise<HistoryLine[]> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: { orderId, id: { notIn: exceptIds }, status: { not: "FAILED" } },
    orderBy: { occurredAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, text: true, occurredAt: true },
  });
  return rows
    .reverse()
    .map((m) => {
      const c = localClock(tz, m.occurredAt);
      return { direction: m.direction === "INBOUND" ? ("in" as const) : ("out" as const), text: emailNewText(m.text) || m.text.trim(), at: `${c.dateStr.slice(5)} ${c.timeStr}` };
    })
    .filter((l) => l.text);
}
