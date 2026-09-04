/**
 * Что мы говорим модели и как читаем её ответ.
 *
 * Чистый модуль: ни БД, ни сети. Здесь живут ЖЁСТКИЕ правила — то, чего ассистент не должен
 * говорить клиенту никогда, — и разбор ответа. Модель может вернуть что угодно, включая мусор,
 * поэтому разбор устроен так, что при любом сомнении ответ уходит человеку, а не клиенту.
 */

export type OrderSnapshot = {
  orderNumber: string;
  storeName: string;
  /** Статус заказа и доставки человеческими словами (для модели, не для клиента). */
  orderStatus: string;
  deliveryStatus: string | null;
  deliveryDate: string | null;
  deliveryWindow: string | null;
  recipientName: string | null;
  deliveryAddress: string | null;
  trackingUrl: string | null;
  photoUrl: string | null;
  totalFormatted: string | null;
  /** Кто пишет: заказчик или получатель — им можно разное. */
  party: "customer" | "recipient" | "unknown";
};

export type HistoryLine = { direction: "in" | "out"; text: string; at: string };

export type PromptInput = {
  knowledgeBase: string | null;
  order: OrderSnapshot | null;
  history: HistoryLine[];
  incomingText: string;
};

export type DeepseekMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Правила поведения. Написаны по-английски: модель отвечает клиенту по-английски, и смешивать
 * языки в инструкции — верный способ получить русский текст наружу.
 */
const RULES_KNOWN_ORDER = `You are a customer service assistant for a flower delivery shop.

HARD RULES — never break them:
- Reply ONLY in English, whatever language the customer writes in.
- Keep it short: one or two sentences, SMS style, no greetings like "Dear customer", no signatures.
- NEVER reveal: the florist's name, internal team notes, or what flowers are in the bouquet.
- You MAY state the order total if asked. You may NEVER offer or promise a refund, a discount, a
  delivery date change, an address change, or any compensation — for any of those set
  "needs_human": true and write a reply that only says a team member will follow up.
- Never invent facts. If the answer is not in the order data or the knowledge base, set
  "needs_human": true.
- Never apologize on behalf of the shop for something you cannot verify.

Set "important": true when the customer talks about: cancelling, a refund, a complaint, flowers
not delivered, a wrong or damaged bouquet, a wrong address, a funeral or a death, or threatens a
bad review.

If the customer tells you when they will be available to receive the delivery, put their own
words in "ready_time" (for example "after 5pm", "tomorrow morning"), otherwise null.

Answer with JSON only:
{"reply_en": string, "intent": string, "important": boolean, "needs_human": boolean, "ready_time": string|null}
"intent" is a short slug such as "tracking", "delivery_time", "photo", "address_change", "refund", "other".`;

const RULES_UNKNOWN_NUMBER = `You are a customer service assistant for a flower delivery shop.
This person writes from a phone number that is NOT linked to any order.

HARD RULES — never break them:
- Reply ONLY in English. Keep it short, SMS style.
- Your first goal is to find out which order they mean: ask for the name on the order or the
  delivery address. Ask for ONE thing at a time.
- Answer general questions (hours, delivery areas, prices, how ordering works) from the knowledge
  base below. If the knowledge base does not cover it, set "needs_human": true.
- Never promise refunds, discounts, dates, or anything about a specific order — you have no order data.

Set "important": true for complaints, refunds, cancellations, undelivered flowers, or anything
that sounds urgent.

Answer with JSON only:
{"reply_en": string, "intent": string, "important": boolean, "needs_human": boolean, "ready_time": null}`;

/** Срез заказа для модели. Отдаём всё, что знаем: решение владельца. */
function orderBlock(o: OrderSnapshot): string {
  const lines = [
    `Order: ${o.orderNumber} (${o.storeName})`,
    `Status: ${o.orderStatus}${o.deliveryStatus ? `, delivery ${o.deliveryStatus}` : ""}`,
    o.deliveryDate ? `Delivery date: ${o.deliveryDate}${o.deliveryWindow ? `, ${o.deliveryWindow}` : ""}` : "Delivery date: not set",
    o.recipientName ? `Recipient: ${o.recipientName}` : null,
    o.deliveryAddress ? `Address: ${o.deliveryAddress}` : null,
    o.trackingUrl ? `Tracking link: ${o.trackingUrl}` : "Tracking link: not available yet",
    o.photoUrl ? `Bouquet photo link: ${o.photoUrl}` : "Bouquet photo: not available",
    o.totalFormatted ? `Order total: ${o.totalFormatted}` : null,
    `The person writing is the: ${o.party}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildMessages(input: PromptInput): DeepseekMessage[] {
  const rules = input.order ? RULES_KNOWN_ORDER : RULES_UNKNOWN_NUMBER;
  const knowledge = input.knowledgeBase?.trim()
    ? `Shop knowledge base (authoritative, use it before anything else):\n${input.knowledgeBase.trim()}`
    : "Shop knowledge base: empty.";

  const parts = [knowledge];
  if (input.order) parts.push(`Order data:\n${orderBlock(input.order)}`);
  if (input.history.length) {
    const lines = input.history.map((h) => `${h.at} ${h.direction === "in" ? "customer" : "shop"}: ${h.text}`);
    parts.push(`Recent conversation (oldest first):\n${lines.join("\n")}`);
  }
  parts.push(`New message from the customer:\n${input.incomingText}`);

  return [
    { role: "system", content: rules },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export type ParsedReply = {
  replyEn: string;
  intent: string;
  important: boolean;
  needsHuman: boolean;
  readyTime: string | null;
};

/** Кириллица в тексте наружу — запрещена жёстко, а не «нежелательна». */
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Разбор ответа модели. Любая неожиданность — не ошибка, а повод отдать ответ человеку:
 * поэтому здесь нет исключений, есть `needsHuman: true`.
 */
export function parseReply(raw: string): ParsedReply {
  let data: Record<string, unknown> = {};
  try {
    // Модель иногда оборачивает JSON в ```json — срезаем обёртку, если она есть.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    data = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return { replyEn: "", intent: "unparsed", important: false, needsHuman: true, readyTime: null };
  }

  const replyEn = typeof data.reply_en === "string" ? data.reply_en.trim() : "";
  const intent = typeof data.intent === "string" && data.intent.trim() ? data.intent.trim().slice(0, 40) : "other";
  const important = data.important === true;
  const needsHuman = data.needs_human === true || !replyEn;
  const readyTime = typeof data.ready_time === "string" && data.ready_time.trim() ? data.ready_time.trim() : null;

  // Русский текст клиенту не уходит ни при каких условиях: правило владельца, и оно жёстче
  // любой инструкции в промпте — инструкцию модель может проигнорировать, эту проверку нет.
  if (CYRILLIC.test(replyEn)) return { replyEn: "", intent, important, needsHuman: true, readyTime };

  return { replyEn, intent, important, needsHuman, readyTime };
}
