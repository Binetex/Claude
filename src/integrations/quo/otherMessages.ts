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
  // «code is 4455» без уточнения — это ЧАЩЕ ВСЕГО клиент про домофон, а не код подтверждения:
  // «The gate code is 4455», «the door code is 1234, leave them inside». Поэтому голый «code is»
  // засчитывается только когда перед ним НЕ стоит слово про вход в дом.
  { topic: "SERVICE", re: /\b(verification|activation|security|confirmation|one[- ]time|login|otp)\s+code\b|(?<!\b(?:gate|door|building|entry|entrance|callbox|call ?box|buzzer|lock|key|apartment|apt|unit|elevator|garage|front)\s)\bcode is:?\s*\d{4,8}\b|\bnot set up for texting\b|\bno longer in service\b|\bmessage blocking is active\b|\b(do not|don't|doesn't|does not) monitor this (line|number)\b|\bthis (line|number|mailbox) is not monitored\b|\bunable to receive (text|sms)\b/ },

  // 2. Рассылки про кредиты и «финансирование бизнеса» — самая массовая помеха.
  //    Имя владельца отдельно НЕ ловим: в выборке есть живые клиенты «Emmanuelle» и «Manuel».
  //    Список слов расширен 14.09.2026 по боевой выборке: половина рассылок обходилась без слова
  //    «loan» («I can pay off a lender or fund your business myself», «Up to 5M, no middlemen»),
  //    и ассистент отвечал им как клиентам. Проверено на 260 живых входящих за 9 дней: совпали
  //    все 18 рассылок и ни одно сообщение клиента.
  //    Слова, которые встречаются и у живых клиентов, из правила УБРАНЫ (проверено на выдумках,
  //    которые легко написал бы настоящий человек): «best email» («what is your best email so I
  //    can send a picture»), «financing» («do you offer financing for a wedding order?»), «intake
  //    form» (так пишут похоронные дома), «up to 2k» (бюджет). Ловить спам на 100% незачем:
  //    непойманное всё равно разбирает модель и молчит по своему правилу, а вот проглоченный
  //    живой клиент — это потерянный заказ.
  { topic: "SPAM", re: /\b(funding|lender|lenders|loan|loans|line of credit|lines of credit|working capital|new capital|unsecured capital|merchant cash|merchant solution|payback|prepayment|pre-?approved|no middleman|no middlemen|underwriting|underwriter|term sheet|term loans?|cash injection|cash advance|sba|s\.b\.a|mca|ucc|mo rev|marketing campaign|seo services|invoice factoring|broker fee)\b|\breply (stop|yes|go)\b|\b(opt out|opt-out|unsubscribe)\b|\bbaghoumian\b|\bparadise flower co\b|\bcould the business put to use\b|\bpay ?off (any|your|current|option)\b|\bfund (your|the) business\b/ },

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
