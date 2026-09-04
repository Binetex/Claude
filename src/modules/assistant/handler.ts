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
import { shouldConsider, decideDelivery, type AssistantMode } from "./policy";
import type { AssistantIncomingPayload } from "./events";

/** Сколько последних сообщений переписки показываем модели. */
const HISTORY_LIMIT = 10;

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

    const order = incoming.orderId
      ? await prisma.order.findUnique({
          where: { id: incoming.orderId },
          include: { site: true },
        })
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

    const cfg = getDeepseekConfig();
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "model_not_configured");
      return;
    }

    const messages = buildMessages({
      knowledgeBase: order ? site.aiKnowledgeBase : site.aiUnknownKnowledgeBase,
      order: order ? snapshot(order, site.name, incoming.partyRole) : null,
      history: await loadHistory(prisma, order?.id ?? null, incoming.id),
      incomingText: text,
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

    const parsed = parseReply(raw);
    const action = decideDelivery({
      mode: site.aiMode as AssistantMode,
      dryRun: site.aiDryRun,
      hasReply: !!parsed.replyEn,
      needsHuman: parsed.needsHuman,
      important: parsed.important,
    });

    await prisma.aiTurn.create({
      data: {
        siteId: site.id,
        orderId: order?.id ?? null,
        communicationId: incoming.id,
        // Отправка живому человеку — отдельный шаг (этап 2); здесь ответ только готовится.
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
    });
  };
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
    where: { orderId, id: { not: exceptId }, messageText: { not: null } },
    orderBy: { occurredAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, messageText: true, occurredAt: true },
  });
  return rows
    .reverse()
    .map((r) => ({
      direction: r.direction === "INBOUND" ? ("in" as const) : ("out" as const),
      text: (r.messageText ?? "").slice(0, 300),
      at: r.occurredAt.toISOString().slice(11, 16),
    }));
}

type OrderWithSite = { orderNumber: string; orderStatus: string; deliveryStatus: string | null; deliveryDate: Date | null; deliveryWindow: string | null; recipientName: string | null; deliveryAddress: string | null; trackingUrl: string | null; total: unknown };

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
    // Фото букета — этап 5: страницу по ссылке ещё не построили.
    photoUrl: null,
    totalFormatted: o.total != null ? `$${String(o.total)}` : null,
    party: partyRole === "CUSTOMER" ? "customer" : partyRole === "RECIPIENT" ? "recipient" : "unknown",
  };
}

/** Полный текст запроса для журнала: владелец должен видеть, что именно спрашивали. */
function renderPrompt(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}
