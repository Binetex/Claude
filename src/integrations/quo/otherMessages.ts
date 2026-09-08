import { normalizeApostrophes } from "@/modules/assistant/policy";

/**
 * Категории «Других сообщений» — входящих SMS и звонков, которые не привязались ни к одному
 * заказу. Правила выведены из 300 настоящих сообщений с прода (сентябрь 2026).
 *
 * Категория НЕ хранится в базе: она считается на лету по склейке текстов переписки. В базе
 * лежит только ручная правка (OrderCommunication.topicManual) — человек всегда сильнее правила.
 * Так экран работает сразу на всех 2355 существующих записях, без бэкфилла, а поправить
 * правило можно в любой момент, не переписывая данные.
 *
 * Нейросеть, когда её подключим, пишет в тот же topicManual (или в соседнюю колонку) — правило
 * останется дешёвым запасным вариантом для того, что она ещё не разобрала.
 */
export const TOPIC_KEYS = ["SPAM", "SERVICE", "JOB", "EXISTING_ORDER", "PICKUP", "DELIVERY", "NEW_ORDER", "OTHER"] as const;
export type TopicKey = (typeof TOPIC_KEYS)[number];

export const TOPIC_LABEL: Record<TopicKey, string> = {
  NEW_ORDER: "Хотят купить",
  PICKUP: "Самовывоз и адрес",
  DELIVERY: "Доставка",
  EXISTING_ORDER: "По заказу",
  SPAM: "Спам и рассылки",
  JOB: "Ищут работу",
  SERVICE: "Служебное",
  OTHER: "Прочее",
};

/**
 * Порядок КНОПОК в интерфейсе — по частоте, с которой категорию ставят руками.
 * Отличается от TOPIC_KEYS: там порядок правил (что важнее при совпадении нескольких),
 * и в кнопках он читался бы как случайный.
 */
export const TOPIC_UI_ORDER: readonly TopicKey[] = ["NEW_ORDER", "PICKUP", "DELIVERY", "EXISTING_ORDER", "SPAM", "JOB", "SERVICE", "OTHER"];

export function isTopicKey(v: string): v is TopicKey {
  return (TOPIC_KEYS as readonly string[]).includes(v);
}

/**
 * Приводим текст к виду, на котором работают правила: типографские кавычки и тире с айфонов
 * ломали бы `can't find`, регистр и переносы — всё остальное.
 */
export function normalizeForRules(raw: string): string {
  return normalizeApostrophes(raw)
    // Длинные тире с телефонов: «same–day» — то же слово, что «same-day».
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Порядок правил — это и есть приоритет: побеждает ПЕРВОЕ совпадение.
 *
 * Он не случаен. «Ищут работу» стоит выше доставки, иначе «looking for a delivery driver job»
 * попадает в «Доставку». Служебные коды стоят выше спама, иначе вкладка «Спам» перестаёт
 * означать спам. «Хотят купить» — последняя из содержательных: её слова («order», «flowers»)
 * встречаются и в вопросах про самовывоз, и в письмах про существующий заказ.
 */
const RULES: { topic: TopicKey; re: RegExp }[] = [
  // 1. Служебные автосообщения операторов и коды подтверждения — не спам и не клиент.
  { topic: "SERVICE", re: /\b(verification|activation|security|confirmation)\s+code\b|\bcode is:?\s*\d{4,8}\b|\bnot set up for texting\b|\bno longer in service\b|\bmessage blocking is active\b/ },

  // 2. Рассылки про кредиты и «финансирование бизнеса» — самая массовая помеха.
  //    Имя владельца отдельно НЕ ловим: в выборке есть живые клиенты «Emmanuelle» и «Manuel».
  { topic: "SPAM", re: /\b(funding|lender|loan|loans|line of credit|working capital|merchant cash|merchant solution|payback|prepayment|pre-?approved|no middleman|financing|underwriting|term sheet|unsecured capital|ucc|mo rev|intake form|marketing campaign)\b|\breply (stop|yes)\b|\b(opt out|unsubscribe)\b|\bbaghoumian\b|\bparadise flower co\b|\bcould the business put to use\b/ },

  // 3. Соискатели и курьеры. ВЫШЕ доставки: иначе «delivery driver» уедет в «Доставку».
  { topic: "JOB", re: /\b(are you hiring|hiring\?|looking for a job|need a job|part-?time job|delivery driver (job|position)|years of experience|clean driving record|my resume|apply for)\b/ },

  // 4. Про уже существующий заказ.
  { topic: "EXISTING_ORDER", re: /\border\s*#\s*\d+|\bmy order\b|\bi (just )?placed an order\b|\bi ordered\b|\bcancel (my|the) order\b|\bstatus of my order\b|\bconfirmation of delivery\b|\bhaven'?t received\b|\bstill waiting for\b|\bchange the (note|card)\b/ },

  // 5. Самовывоз и «не могу найти магазин» — по делу это один и тот же разговор.
  { topic: "PICKUP", re: /\bpick\s?-?up\b|\bpick (them|it|these|those|the flowers) up\b|\bwalk[- ]?ins?\b|\bcome (by|in|now|over|pick)\b|\bstop by\b|\bcan'?t (find|locate|see) (you|your|the)\b|\bwhere (are|is) (you|your shop|your store|the store)\b|\byour location\b|\bgoogle maps\b|\bi'?m (outside|at) (your|the) (store|shop|address)\b|\bare you located\b|\b(drive|driving|walk) to (your|the) (shop|store)\b|\b(find|finding|locate) (the|your) (shop|store)\b|\bdo (you|u) (guys )?have a (store|shop)\b|\bstore location\b|\ba store where i can\b/ },

  // 6. Доставка.
  { topic: "DELIVERY", re: /\bdeliver(y|ed|ing)?\b|\bsame[- ]day\b|\bsend (flowers|a bouquet|something)\b|\bdrop ?off\b/ },

  // 7. Хотят купить.
  { topic: "NEW_ORDER", re: /\b(place|make|put in) an? order\b|\b[il]'?d like to (order|buy|get)\b|\bwant(ed)? to (buy|order|purchase)\b|\bi need (a |some )?(flowers?|arrangement|bouquet|roses)\b|\bcan i (buy|order|get|purchase)\b|\blooking to (buy|order|purchase)\b|\b(do you (have|carry|sell)|if you (have|had|carry|got))\b[^.?!]*\b(flowers?|sunflowers?|roses|lil(l)?ies|bouquet|arrangement|tulips?|peonies|orchids?|carnations?)\b|\bfor a (wedding|funeral|graduation|birthday|anniversary)\b|\bquiero comprar\b|\bramo de flores\b|\bhow much (for|is|would|are)\b|\bwhat'?s? (is )?the price\b|\bi (want|need) flowers\b|\bi need to send (her|him|them)\b/ },
];

/**
 * Категория переписки по её входящим текстам.
 *
 * Классифицируем ВСЮ переписку, а не последнее сообщение: последнее почти всегда огрызок
 * («Yes», «?», «Ok»), а смысл разговора живёт в первой реплике.
 */
export function classifyThread(texts: (string | null | undefined)[]): TopicKey {
  const joined = normalizeForRules(texts.filter(Boolean).join(" \n "));
  if (!joined) return "OTHER";
  for (const rule of RULES) if (rule.re.test(joined)) return rule.topic;
  return "OTHER";
}
