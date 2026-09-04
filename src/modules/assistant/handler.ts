import "server-only";
/**
 * Разбор одного входящего сообщения ассистентом.
 *
 * Порядок намеренно такой: сначала дешёвые проверки (правила, потолки, тишина), и только потом
 * обращение к модели — вопрос «а надо ли вообще отвечать» не стоит ни одного запроса. Что бы ни
 * случилось дальше, наружу ничего не уходит, пока владелец не включил режим и не снял сухой
 * прогон: молчание безопаснее лишнего сообщения живому человеку.
 *
 * Каждый разбор оставляет строку в `AiTurn` — включая отказ отвечать и его причину. Без этого
 * на вопрос «почему по заказу тишина» нечем ответить, кроме догадок.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { getDeepseekConfig } from "@/integrations/deepseek/config";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { buildMessages, parseReply, type HistoryLine, type OrderSnapshot } from "./prompt";
import { matchIntent } from "./intents";
import { readTemplates, templateApplies } from "./templates";
import { loadCatalog, looksLikeShopping } from "./catalog";
import { renderTemplate } from "@/modules/messaging/template";
import { buildOrderVariables } from "@/modules/messaging/variables";
import { orderToVariableSource, SMS_ORDER_INCLUDE } from "@/modules/messaging/orderSource";
import { shouldConsider, decideDelivery, type AssistantMode } from "./policy";
import { scheduleAssistantNudge, type AssistantIncomingPayload } from "./events";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { sendAssistantReply, notifyDraft } from "./deliver";
import { prependReadyTimeNote } from "./note";
import { findOrderByHint, linkConversation } from "./link";
import { bouquetPageUrl } from "@/lib/bouquetPage";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/**
 * Сколько последних сообщений переписки показываем модели. Двадцать — вся живая переписка по
 * заказу: клиент часто ссылается на сказанное раньше («как договаривались»), и без этого
 * ассистент отвечает в вакууме.
 */
const HISTORY_LIMIT = 20;

export type AssistantDeps = {
  /** Инъекция клиента модели — в тестах реального обращения быть не должно. */
  client?: DeepseekClient | null;
  now?: () => Date;
};

export function buildAssistantHandler(prisma: PrismaClient, deps: AssistantDeps = {}) {
  const now = deps.now ?? (() => new Date());

  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as AssistantIncomingPayload;
    if (!p?.communicationId) return;

    const incoming = await prisma.orderCommunication.findUnique({
      where: { id: p.communicationId },
      select: {
        id: true, orderId: true, direction: true, messageText: true, transcript: true, summary: true,
        type: true, partyRole: true, externalPhoneNormalized: true, storePhone: true, occurredAt: true,
      },
    });
    if (!incoming || incoming.direction !== "INBOUND") return;

    // Разбор уже был: одно входящее — один разбор, повтор обработчика ничего не создаёт.
    const existing = await prisma.aiTurn.findUnique({ where: { communicationId: incoming.id }, select: { id: true } });
    if (existing) return;

    // Тот же срез заказа, что у автоматизаций: переменные шаблонов обязаны считаться одинаково,
    // иначе «во сколько привезут» в заготовке и в правиле разойдутся.
    const order = incoming.orderId
      ? await prisma.order.findUnique({ where: { id: incoming.orderId }, include: SMS_ORDER_INCLUDE })
      : null;

    // Магазин: у привязанного входящего — от заказа, у незнакомого номера — по номеру магазина,
    // на который написали. Не нашли магазин — разбирать нечего и негде.
    const site = order?.site
      ?? (incoming.storePhone
        ? await prisma.site.findFirst({ where: { quoPhoneNumber: incoming.storePhone } })
        : null);
    if (!site) return;

    const text = pickText(incoming);

    const dayStart = new Date(now());
    dayStart.setHours(0, 0, 0, 0);
    const [repliesToday, repliesTotal, lastAutomated] = order
      ? await Promise.all([
          prisma.aiTurn.count({ where: { orderId: order.id, status: "SENT", createdAt: { gte: dayStart } } }),
          prisma.aiTurn.count({ where: { orderId: order.id, status: "SENT" } }),
          prisma.orderCommunication.findFirst({
            where: {
              orderId: order.id,
              direction: "OUTBOUND",
              OR: [{ automationJobs: { some: {} } }, { flowRunSteps: { some: {} } }],
            },
            orderBy: { occurredAt: "desc" },
            select: { occurredAt: true },
          }),
        ])
      : [0, 0, null];

    const gate = shouldConsider({
      mode: site.aiMode as AssistantMode,
      orderDisabled: !!order?.aiDisabled,
      orderClosed: !!order && TERMINAL_ORDER_STATUSES.includes(order.orderStatus) && order.orderStatus === "CANCELLED",
      deliveredAt: order?.deliveryStatus === "DELIVERED" ? order.updatedAt : null,
      text,
      lastAutomatedAt: lastAutomated?.occurredAt ?? null,
      repliesToday,
      repliesTotal,
      now: now(),
    });
    if (!gate.ok) {
      // Отказ тоже записываем: «почему по заказу тишина» — первый вопрос владельца.
      if (gate.reason !== "assistant_off") await logSkip(prisma, site.id, order?.id ?? null, incoming.id, gate.reason);
      return;
    }

    // Заготовка сильнее модели: на «где мой заказ» ответ один и тот же, и тратить на него запрос,
    // рискуя выдумкой, незачем. Только для заказов: у незнакомого номера подставлять нечего.
    if (order) {
      const intent = matchIntent(text);
      if (intent) {
        const setting = readTemplates(site.aiTemplatesJson)[intent.key];
        const vars = buildOrderVariables(orderToVariableSource(order));
        if (templateApplies(intent, setting, vars)) {
          const rendered = renderTemplate(setting.text, vars);
          // Незаполненная переменная рендерится пустотой и съедает часть фразы — такой ответ
          // клиенту не уходит, вопрос честнее отдать модели.
          if (rendered.missing.length === 0 && rendered.text.trim()) {
            const action = decideDelivery({
              mode: site.aiMode as AssistantMode,
              dryRun: site.aiDryRun,
              hasReply: true,
              needsHuman: false,
              important: false,
            });
            const turn = await prisma.aiTurn.create({
              data: {
                siteId: site.id, orderId: order.id, communicationId: incoming.id,
                status: "DRAFT", source: "template", intent: intent.key,
                replyText: rendered.text,
                needsHuman: action === "draft",
              },
              select: { id: true },
            });
            await finishTurn(prisma, turn.id, action, site.aiDryRun);
            return;
          }
        }
      }
    }

    const cfg = getDeepseekConfig();
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "model_not_configured");
      return;
    }

    // Каталог нужен не всегда: на «во сколько привезут» он только раздувает запрос. Но у
    // незнакомого номера разговор почти всегда про покупку, поэтому там он идёт сразу.
    const wantsCatalog = !order || looksLikeShopping(text);
    const messages = buildMessages({
      knowledgeBase: order ? site.aiKnowledgeBase : site.aiUnknownKnowledgeBase,
      order: order ? snapshot(order, site.name, incoming.partyRole) : null,
      history: await loadHistory(prisma, order?.id ?? null, incoming.id),
      incomingText: text,
      catalog: wantsCatalog ? await loadCatalog(prisma, site.id).catch(() => []) : undefined,
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
      // Модель недоступна — клиенту не уходит ничего (решение владельца). Строка в журнале
      // остаётся, чтобы молчание можно было объяснить.
      const code = err instanceof DeepseekError ? err.code : "unknown";
      await prisma.aiTurn.create({
        data: {
          siteId: site.id, orderId: order?.id ?? null, communicationId: incoming.id,
          status: "FAILED", source: "model", skipReason: `model_${code}`,
          promptText: renderPrompt(messages),
        },
      });
      return;
    }

    let parsed = parseReply(raw);

    // Незнакомый номер назвал заказ. Нашли ровно один — привязываем разговор и спрашиваем
    // модель ещё раз, уже с данными заказа: человек ждёт ответа про свой заказ сейчас, а не в
    // следующем сообщении. Один повтор, не рекурсия: второй подсказки в ответе с заказом не бывает.
    let linkedOrder = order;
    if (!order && parsed.orderHint) {
      const foundId = await findOrderByHint(prisma, site.id, parsed.orderHint).catch(() => null);
      if (foundId) {
        await linkConversation(prisma, foundId, incoming.externalPhoneNormalized).catch(() => null);
        linkedOrder = await prisma.order.findUnique({ where: { id: foundId }, include: SMS_ORDER_INCLUDE });
        if (linkedOrder) {
          const again = buildMessages({
            knowledgeBase: site.aiKnowledgeBase,
            order: snapshot(linkedOrder, site.name, incoming.partyRole),
            history: await loadHistory(prisma, linkedOrder.id, incoming.id),
            incomingText: text,
          });
          try {
            const res = await client.complete(again);
            raw = res.text;
            latencyMs += res.latencyMs;
            parsed = parseReply(raw);
            messages.splice(0, messages.length, ...again);
          } catch {
            // Не вышло переспросить — остаёмся с ответом «без заказа», он безопасен.
          }
        }
      }
    }

    const action = decideDelivery({
      mode: site.aiMode as AssistantMode,
      dryRun: site.aiDryRun,
      hasReply: !!parsed.replyEn,
      needsHuman: parsed.needsHuman,
      important: parsed.important,
    });

    // Клиент назвал время — это данные заказа, а не только реплика: строка в заметку сверху и
    // уведомление владельцу и флористу. В сухом прогоне не пишем и не уведомляем: он пассивный.
    if (parsed.readyTime && linkedOrder && !site.aiDryRun) {
      const forNote = linkedOrder;
      await recordReadyTime(prisma, forNote, incoming.id, parsed.readyTime, text).catch((err) =>
        console.error(`[assistant] заметка о времени по заказу ${forNote.id} не записана:`, err instanceof Error ? err.message : String(err))
      );
    }

    const turn = await prisma.aiTurn.create({
      data: {
        siteId: site.id,
        orderId: linkedOrder?.id ?? null,
        communicationId: incoming.id,
        status: "DRAFT",
        source: "model",
        intent: parsed.intent,
        important: parsed.important,
        needsHuman: parsed.needsHuman || action === "draft",
        replyText: parsed.replyEn || null,
        promptText: renderPrompt(messages),
        responseText: raw,
        modelName,
        latencyMs,
      },
      select: { id: true },
    });
    await finishTurn(prisma, turn.id, action, site.aiDryRun);
  };
}

/**
 * Что делать с готовым разбором: отправить самому или показать человеку.
 *
 * Сухой прогон не доходит сюда ни одним путём: `decideDelivery` в нём всегда возвращает
 * черновик, а черновик в сухом прогоне никуда не показывается — он живёт только в карточке
 * заказа. Так «включу и посмотрю» действительно ничего не отправляет и никого не будит.
 *
 * Сбой показа не должен ронять разбор: черновик уже записан и виден в карточке заказа.
 */
async function finishTurn(prisma: PrismaClient, turnId: string, action: "send" | "draft", dryRun: boolean): Promise<void> {
  try {
    if (action === "send") {
      await sendAssistantReply(prisma, turnId);
      return;
    }
    if (dryRun) return;
    const shown = await notifyDraft(prisma, turnId);
    // Напоминание ставим, только если черновик реально дошёл до человека: иначе «одну минуту»
    // уйдёт клиенту по разбору, которого никто не видел.
    if (shown) await scheduleAssistantNudge(new PrismaOutboxRepository(prisma), turnId, new Date());
  } catch (err) {
    console.error(`[assistant] показ черновика ${turnId} не удался:`, err instanceof Error ? err.message : String(err));
  }
}

/** Текст входящего: у SMS — сам текст, у звонка — расшифровка или краткое содержание. */
function pickText(c: { messageText: string | null; transcript: string | null; summary: string | null }): string {
  return (c.messageText || c.transcript || c.summary || "").trim();
}

async function logSkip(prisma: PrismaClient, siteId: string, orderId: string | null, communicationId: string, reason: string) {
  await prisma.aiTurn.create({
    data: { siteId, orderId, communicationId, status: "SKIPPED", source: "none", skipReason: reason },
  });
}

/** Переписка по заказу, старые сверху: ассистент не должен отвечать в вакууме. */
async function loadHistory(prisma: PrismaClient, orderId: string | null, exceptId: string): Promise<HistoryLine[]> {
  if (!orderId) return [];
  const rows = await prisma.orderCommunication.findMany({
    where: {
      orderId,
      id: { not: exceptId },
      // Звонок — такая же часть разговора, как SMS: клиент часто ссылается на сказанное голосом.
      OR: [{ messageText: { not: null } }, { transcript: { not: null } }, { summary: { not: null } }],
    },
    orderBy: { occurredAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, messageText: true, transcript: true, summary: true, type: true, occurredAt: true },
  });
  return rows
    .reverse()
    .map((r) => {
      const body = r.messageText ?? r.transcript ?? r.summary ?? "";
      const prefix = r.messageText ? "" : "(call) ";
      return {
        direction: r.direction === "INBOUND" ? ("in" as const) : ("out" as const),
        text: `${prefix}${body}`.slice(0, 400),
        at: r.occurredAt.toISOString().slice(11, 16),
      };
    });
}

type OrderWithSite = { orderNumber: string; orderStatus: string; deliveryStatus: string | null; deliveryDate: Date | null; deliveryWindow: string | null; recipientName: string | null; deliveryAddress: string | null; trackingUrl: string | null; bouquetPhotoUrl: string | null; total: unknown };

function snapshot(order: Record<string, unknown>, storeName: string, partyRole: string): OrderSnapshot {
  const o = order as unknown as OrderWithSite;
  return {
    orderNumber: o.orderNumber,
    storeName,
    orderStatus: String(o.orderStatus).toLowerCase(),
    deliveryStatus: o.deliveryStatus ? String(o.deliveryStatus).toLowerCase() : null,
    deliveryDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : null,
    deliveryWindow: o.deliveryWindow ?? null,
    recipientName: o.recipientName ?? null,
    deliveryAddress: o.deliveryAddress ?? null,
    trackingUrl: o.trackingUrl ?? null,
    // Клиенту уходит страница с фото, а не сырой файл (картинку в SMS не вложить).
    photoUrl: bouquetPageUrl(o.bouquetPhotoUrl),
    totalFormatted: o.total != null ? `$${String(o.total)}` : null,
    party: partyRole === "CUSTOMER" ? "customer" : partyRole === "RECIPIENT" ? "recipient" : "unknown",
  };
}

/** Полный текст запроса для журнала: владелец должен видеть, что именно спрашивали. */
function renderPrompt(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/**
 * Слова клиента о времени готовности — в заметку заказа и в Telegram тем, кто везёт и кто
 * отвечает. Заметка перечитывается перед записью: пока шёл запрос к модели, её могли поправить
 * руками, и затирать чужую правку старой копией нельзя.
 */
async function recordReadyTime(
  prisma: PrismaClient,
  order: { id: string; currentFloristId: string | null; site: { timezone: string | null } },
  communicationId: string,
  readyTime: string,
  quote: string
): Promise<void> {
  const fresh = await prisma.order.findUnique({ where: { id: order.id }, select: { customerNote: true } });
  await prisma.order.update({
    where: { id: order.id },
    data: { customerNote: prependReadyTimeNote(fresh?.customerNote ?? "", readyTime, new Date(), order.site.timezone) },
  });
  const context = { readyTime, quote: quote.slice(0, 200) };
  await publishTelegramNotification(prisma, { type: "customer.ready_time", orderId: order.id, occurrenceKey: communicationId, context });
  if (order.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "customer.ready_time_florist", orderId: order.id, floristId: order.currentFloristId, occurrenceKey: communicationId, context,
    });
  }
}
