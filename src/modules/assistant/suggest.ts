import "server-only";
/**
 * Кнопка ✨ у «Отправить» в переписке заказа (владелец 01.10.2026: «маленькая кнопочка рядом с
 * кнопкой отправить — запускает нейронку и пишет текст ответа клиенту»). ИИ пишет текст в поле
 * ответа, отправляет человек сам, этой же формой. Нажал ещё раз — другой вариант: прошлые варианты
 * приходят в `avoid`, и модель их не повторяет.
 *
 * Запрос — тот же, что у ассистента на входящее (`handler.ts`): правила, факты заказа, время по
 * графику, переписка ТОЛЬКО с этой стороной заказа. Отвечает на последние сообщения клиента, на
 * которые мы ещё не ответили, и проходит ту же проверку `parseReply` (английский, запретные
 * обещания, не раньше графика).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { toE164 } from "@/lib/phone";
import { localClock } from "@/lib/tz";
import { buildMessages, parseReply, agreeFromMin, type DeepseekMessage } from "./prompt";
import { loadOrder, loadHistory, pickText, snapshot, earliestFor, earliestLabel } from "./handler";
import { loadGlobalNote, activeGlobalNoteText } from "./globalNote";
import { loadCatalog, looksLikeShopping } from "./catalog";

/** Другой вариант — не тот же другими словами: температура выше обычной. */
const AGAIN_TEMPERATURE = 0.9;

export type SuggestResult =
  | { ok: true; text: string }
  | { ok: false; code: "order_not_found" | "no_phone" | "model_not_configured" | "model_failed" | "no_reply" };

export async function suggestReply(
  prisma: PrismaClient,
  args: { orderId: string; target: "CUSTOMER" | "RECIPIENT"; avoid?: string[] },
  deps: { client?: DeepseekClient; now?: () => Date } = {},
): Promise<SuggestResult> {
  const now = deps.now?.() ?? new Date();
  const order = await loadOrder(prisma, args.orderId);
  if (!order) return { ok: false, code: "order_not_found" };
  const phone = toE164(args.target === "CUSTOMER" ? order.senderPhone : order.recipientPhone);
  if (!phone) return { ok: false, code: "no_phone" };
  const site = order.site;

  // На что отвечаем: сообщения этой стороны после нашего последнего ответа ей. Их нет — последнее
  // её сообщение; не писала вовсе — пишем первыми.
  const lastOut = await prisma.orderCommunication.findFirst({
    where: { orderId: order.id, externalPhoneNormalized: phone, direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED"] } },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  const inboundSelect = { id: true, occurredAt: true, messageText: true, transcript: true, summary: true, attachmentsJson: true } as const;
  let unanswered = await prisma.orderCommunication.findMany({
    where: { orderId: order.id, externalPhoneNormalized: phone, direction: "INBOUND", ...(lastOut ? { occurredAt: { gt: lastOut.occurredAt } } : {}) },
    orderBy: { occurredAt: "asc" },
    take: 10,
    select: inboundSelect,
  });
  if (!unanswered.length) {
    const last = await prisma.orderCommunication.findFirst({
      where: { orderId: order.id, externalPhoneNormalized: phone, direction: "INBOUND" },
      orderBy: { occurredAt: "desc" },
      select: inboundSelect,
    });
    unanswered = last ? [last] : [];
  }
  const text = unanswered.map((c) => pickText(c).text).filter((t) => t.trim()).join("\n");
  const anchor = unanswered[0] ?? { id: "", occurredAt: now };

  const clock = localClock(site.timezone, now);
  const earliestMin = await earliestFor(prisma, order, clock.dateStr, now);
  const messages: DeepseekMessage[] = buildMessages({
    knowledgeBase: site.aiKnowledgeBase,
    order: { ...snapshot(order, site.name, args.target, clock.dateStr), earliest: earliestLabel(earliestMin) },
    history: await loadHistory(prisma, order.id, phone, null, anchor, site.timezone, unanswered.map((c) => c.id)),
    now: clock,
    globalNote: activeGlobalNoteText(await loadGlobalNote(prisma), now, site.timezone),
    incomingText: text || "(The customer has not written yet. Write the next message the shop should send them about this order.)",
    catalog: looksLikeShopping(text) ? await loadCatalog(prisma, site.id).catch(() => []) : undefined,
  });
  const avoid = (args.avoid ?? []).map((a) => a.trim()).filter(Boolean).slice(-8);
  if (avoid.length) {
    messages.push({
      role: "user",
      content: [
        "The shop did not like these replies, never reuse them:",
        ...avoid.map((a) => JSON.stringify(a)),
        "",
        "Write a completely different reply: a different approach and different words, not a rephrase. Follow every rule above. Answer in the same JSON format.",
      ].join("\n"),
    });
  }

  const cfg = deps.client ? null : await resolveDeepseekConfig(prisma);
  const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
  if (!client) return { ok: false, code: "model_not_configured" };
  let raw: string;
  try {
    raw = (await client.complete(messages, avoid.length ? { temperature: AGAIN_TEMPERATURE } : {})).text;
  } catch {
    return { ok: false, code: "model_failed" };
  }
  const reply = parseReply(raw, { agreeFromMin: agreeFromMin(earliestMin), plannedFromMin: earliestMin }).replyEn?.trim();
  if (!reply || avoid.some((a) => a.toLowerCase() === reply.toLowerCase())) return { ok: false, code: "no_reply" };
  return { ok: true, text: reply };
}
