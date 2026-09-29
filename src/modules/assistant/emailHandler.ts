import "server-only";
/**
 * Ассистент отвечает и на письма клиента (владелец 29.09.2026: «на емейлы тоже сделать, чтобы ИИ
 * отвечал»). Разбор тот же, что у SMS — правила, проверка ответа, режим магазина, черновик в
 * Telegram, перенос по словам клиента, — другие только вход и выход: письмо из переписки заказа и
 * ответ письмом в тот же тред через наш почтовый модуль (`deliver.ts::sendAssistantReply`).
 *
 * Только письма, привязанные к заказу. Телефонного здесь нет: звонков, фото и очереди SMS у письма
 * не бывает. Письмо, на которое ассистент НЕ ответил (выключен, лимиты, «спасибо», сбой модели),
 * уходит людям обычным уведомлением «клиент ответил на письмо» — почту никто не держит открытой.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { emailNewText, emailQuoteForTelegram } from "@/integrations/emailFactory/ingest";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { SMS_ORDER_INCLUDE } from "@/modules/messaging/orderSource";
import { localClock } from "@/lib/tz";
import { buildMessages, parseReply, agreeFromMin, type HistoryLine } from "./prompt";
import { shouldConsider, decideDelivery, type AssistantMode } from "./policy";
import { junkReason } from "./junk";
import { loadCatalog, looksLikeShopping } from "./catalog";
import { loadGlobalNote, activeGlobalNoteText } from "./globalNote";
import { mentionsTime } from "./note";
import { mentionsDay } from "./reschedule";
import type { AssistantEmailPayload } from "./events";
import {
  snapshot, deliveredMoment, countReplies, renderPrompt, earliestFor, labelOf, finishTurn,
  recordReadyTime, applyCustomerReschedule, alertNoBalance,
} from "./handler";

/** Сколько писем переписки показываем модели: живой переписки по заказу больше не бывает. */
const HISTORY_LIMIT = 12;

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

    // Ответа не будет — людям уходит то же уведомление, что и без ассистента.
    const tellPeople = () =>
      publishTelegramNotification(prisma, {
        type: "customer.email_reply",
        orderId: order.id,
        occurrenceKey: email.providerMessageId ?? email.id,
        context: { from: email.fromEmail, subject: email.subject ?? "", quote: emailQuoteForTelegram(email.text) },
      }).catch(() => null);
    const skip = async (reason: string, notify = true) => {
      await prisma.aiTurn.create({
        data: { siteId: site.id, orderId: order.id, emailMessageId: email.id, status: "SKIPPED", source: "none", skipReason: reason },
      });
      if (notify) await tellPeople();
    };

    const text = emailNewText(email.text);
    if (!text) return skip("empty_text");

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

    // Рассылки и автоответы почтовых роботов — без ответа и без уведомления.
    const junk = junkReason(text, true);
    if (junk) return skip(junk, false);

    // Клиент дописал ещё письмо, пока шла пауза: отвечаем на последнее, оно видит это в переписке.
    const newer = await prisma.orderEmailMessage.count({ where: { orderId: order.id, direction: "INBOUND", occurredAt: { gt: email.occurredAt } } });
    if (newer) return skip("superseded", false);

    const cfg = await resolveDeepseekConfig(prisma);
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) return skip("model_not_configured");

    const clock = localClock(site.timezone, now());
    // Заказчик — если пишет с адреса из заказа. Переносить заказ может только он.
    const isCustomer = !!order.senderEmail && order.senderEmail.trim().toLowerCase() === email.fromEmail.trim().toLowerCase();
    const earliestMin = await earliestFor(prisma, order, clock.dateStr, now());
    const globalNote = activeGlobalNoteText(await loadGlobalNote(prisma), now(), site.timezone);
    const messages = buildMessages({
      channel: "email",
      writerName: isCustomer ? order.senderName : null,
      knowledgeBase: site.aiKnowledgeBase,
      order: { ...snapshot(order, site.name, isCustomer ? "CUSTOMER" : "UNKNOWN", clock.dateStr), earliest: labelOf(earliestMin) },
      history: await loadEmailHistory(prisma, order.id, email.id, site.timezone),
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
      return;
    }

    // «Позвоните мне» из письма — всегда через человека: звонок делают люди, и черновик им это покажет.
    const action = parsed.intent === "call_request"
      ? "draft"
      : decideDelivery({ mode: site.aiMode as AssistantMode, dryRun: site.aiDryRun, hasReply: !!parsed.replyEn, needsHuman: parsed.needsHuman, important: parsed.important });

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
    const confirmed = { from: parsed.confirmedFrom, until: parsed.confirmedUntil };
    if (isCustomer && !site.aiDryRun && (confirmed.from != null || confirmed.until != null || parsed.newDeliveryDate)) {
      await applyCustomerReschedule(prisma, order.id, confirmed, parsed.newDeliveryDate, site.timezone, clock.dateStr).catch((err) =>
        console.error(`[assistant] перенос по заказу ${order.id} (письмо) не применён:`, err instanceof Error ? err.message : String(err))
      );
    }

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
    await finishTurn(prisma, turn.id, action, site.aiDryRun);
  };
}

/** Переписка заказа по почте — от старых к новым, без цитат: модель видит разговор, а не простыни. */
async function loadEmailHistory(prisma: PrismaClient, orderId: string, exceptId: string, tz: string | null): Promise<HistoryLine[]> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: { orderId, id: { not: exceptId }, status: { not: "FAILED" } },
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
