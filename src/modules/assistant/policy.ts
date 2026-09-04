/**
 * Правила ассистента: отвечать ли вообще и кто нажимает «отправить».
 *
 * Чистый модуль без БД: это те решения, из-за которых живой человек получает лишнее сообщение
 * или не получает нужное, и проверять их надо тестами, а не глазами на проде.
 */

/** Сколько ответов ассистента максимум за сутки по одному заказу. */
export const DAILY_CAP = 5;
/** Сколько всего за всю жизнь заказа. */
export const ORDER_CAP = 10;
/** Тишина после АВТОМАТИЧЕСКОГО сообщения: клиент не должен получить два подряд. */
export const AUTOMATED_SILENCE_MIN = 10;
/** Сколько дней после доставки ассистент ещё разговаривает. */
export const DELIVERED_GRACE_DAYS = 3;

export type AssistantMode = "OFF" | "DRAFT" | "AUTO_SIMPLE";

export type ConsiderInput = {
  mode: AssistantMode;
  /** Выключатель на конкретном заказе — сильнее режима магазина. */
  orderDisabled: boolean;
  /** Заказ отменён или иначе закрыт. */
  orderClosed: boolean;
  /** Момент доставки, если заказ доставлен. */
  deliveredAt: Date | null;
  /** Текст входящего. */
  text: string;
  /** Когда по заказу последний раз уходило АВТОМАТИЧЕСКОЕ сообщение (правило или цепочка). */
  lastAutomatedAt: Date | null;
  /** Сколько ответов ассистента уже ушло за сутки и всего по заказу. */
  repliesToday: number;
  repliesTotal: number;
  now: Date;
};

export type ConsiderResult = { ok: true } | { ok: false; reason: string };

/**
 * «Спасибо», «ок», сердечко — вежливая точка в разговоре. Ответ на неё продолжает переписку,
 * которая уже закончилась, и выглядит навязчиво.
 */
const SMALL_TALK = new Set([
  "thanks", "thank you", "thank u", "thankyou", "thx", "ty", "tnx",
  "ok", "okay", "okey", "k", "kk", "got it", "gotit", "great", "perfect",
  "cool", "nice", "yes", "yep", "yeah", "no", "nope", "sure", "fine",
  "спасибо", "спс", "ок", "хорошо", "понял", "поняла",
]);

/** Похоже ли входящее на вежливую точку, а не на вопрос. */
export function isSmallTalk(raw: string): boolean {
  const text = raw
    .toLowerCase()
    // Эмодзи и знаки препинания сами по себе смысла не несут: «👍», «ok!», «thanks :)».
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return true; // одни эмодзи
  if (SMALL_TALK.has(text)) return true;
  // «ok thanks», «thank you very much» — те же слова с хвостом вежливости.
  const words = text.split(" ");
  return words.length <= 4 && words.every((w) => SMALL_TALK.has(w) || w === "you" || w === "very" || w === "much" || w === "so");
}

/** Стоит ли вообще разбирать это входящее. Первая же непройденная проверка — выходим. */
export function shouldConsider(input: ConsiderInput): ConsiderResult {
  if (input.mode === "OFF") return { ok: false, reason: "assistant_off" };
  if (input.orderDisabled) return { ok: false, reason: "order_disabled" };
  if (input.orderClosed) return { ok: false, reason: "order_closed" };

  if (input.deliveredAt) {
    const days = (input.now.getTime() - input.deliveredAt.getTime()) / 86_400_000;
    if (days > DELIVERED_GRACE_DAYS) return { ok: false, reason: "delivered_long_ago" };
  }

  if (!input.text.trim()) return { ok: false, reason: "empty_text" };
  if (isSmallTalk(input.text)) return { ok: false, reason: "small_talk" };

  if (input.lastAutomatedAt) {
    const minutes = (input.now.getTime() - input.lastAutomatedAt.getTime()) / 60_000;
    // Клиенту только что ушло автоматическое сообщение — ответ ассистента вплотную читается
    // как сбой системы, а не как разговор.
    if (minutes < AUTOMATED_SILENCE_MIN) return { ok: false, reason: "recent_automated_message" };
  }

  if (input.repliesToday >= DAILY_CAP) return { ok: false, reason: "daily_cap" };
  if (input.repliesTotal >= ORDER_CAP) return { ok: false, reason: "order_cap" };

  return { ok: true };
}

export type DecideInput = {
  mode: AssistantMode;
  /** Сухой прогон: наружу не уходит ничего, что бы модель ни решила. */
  dryRun: boolean;
  /** Есть ли вообще текст ответа. */
  hasReply: boolean;
  /** Модель не уверена. */
  needsHuman: boolean;
  /** Тема из списка важных (отмена, возврат, жалоба). */
  important: boolean;
};

/** Отправлять самому или нести человеку. */
export function decideDelivery(input: DecideInput): "send" | "draft" {
  if (!input.hasReply) return "draft";
  if (input.dryRun) return "draft";
  if (input.mode !== "AUTO_SIMPLE") return "draft";
  // Важное и неуверенное человек смотрит всегда — цена ошибки здесь выше цены задержки.
  if (input.needsHuman || input.important) return "draft";
  return "send";
}
