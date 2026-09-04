/**
 * Частые вопросы, на которые ответ известен заранее.
 *
 * Шаблон СИЛЬНЕЕ модели: на «где мой заказ» ответ один и тот же, и тратить на него запрос,
 * рискуя выдумкой, незачем. Совпало — уходит готовый текст магазина, модель не вызывается.
 *
 * Ключевые слова живут в коде, а тексты — в настройках магазина: подбирать формулировки
 * владельцу удобно, а составлять списки синонимов — нет.

 */

export type IntentKey = "tracking" | "delivery_time" | "photo" | "delivered_check";

export type IntentDef = {
  key: IntentKey;
  /** Как называется в интерфейсе владельца. */
  label: string;
  /** Подсказка: когда именно сработает. */
  hint: string;
  /** Слова и обороты, по которым узнаём вопрос. Нижний регистр. */
  phrases: string[];
  /**
   * Переменные, без непустых значений которых шаблон НЕ используется: «вот ваш трек» без трека
   * хуже молчания, и такой вопрос лучше отдать модели.
   */
  requires: string[];
  /** Текст по умолчанию — его же владелец видит подсказкой в поле. */
  defaultText: string;
};

export const INTENTS: readonly IntentDef[] = [
  {
    key: "tracking",
    label: "Где мой заказ / трек",
    hint: "Клиент спрашивает ссылку отслеживания или где сейчас курьер.",
    phrases: ["track", "tracking", "where is my order", "where's my order", "where is the order", "status of my order", "order status", "where is my delivery"],
    requires: ["tracking_url"],
    defaultText: "You can follow the delivery here: {{tracking_url}}",
  },
  {
    key: "delivery_time",
    label: "Во сколько привезут",
    hint: "Клиент спрашивает время доставки.",
    phrases: ["what time", "when will it arrive", "when will you deliver", "when are you coming", "delivery time", "eta", "how soon"],
    requires: ["delivery_time"],
    defaultText: "Your delivery is scheduled for {{delivery_time}} today.",
  },
  {
    key: "photo",
    label: "Фото букета",
    hint: "Клиент просит фотографию собранного букета.",
    phrases: ["photo", "picture", "pic of", "send me a photo", "can i see", "what does it look like"],
    // Ссылка появляется, когда флорист загрузил фото; до этого вопрос уходит модели, и та честно
    // скажет, что фото пришлём, как только букет будет собран.
    requires: ["bouquet_photo_url"],
    defaultText: "Here is your bouquet: {{bouquet_photo_url}}",
  },
  {
    key: "delivered_check",
    label: "Доставлен ли заказ",
    hint: "Клиент спрашивает, доставили ли уже цветы.",
    phrases: ["was it delivered", "has it been delivered", "did you deliver", "is it delivered", "already delivered"],
    requires: [],
    defaultText: "Your order was delivered. If anything looks wrong, tell us and we will take care of it.",
  },
] as const;

const BY_KEY = new Map(INTENTS.map((i) => [i.key, i]));

export function getIntent(key: string): IntentDef | null {
  return BY_KEY.get(key as IntentKey) ?? null;
}

/**
 * Какой из известных вопросов задал клиент. Совпадение — по вхождению оборота в текст;
 * ничего умнее здесь не нужно, а всё непонятное честно уходит модели.
 *
 * Вопросов в одном сообщении может быть несколько («where is it and what time?») — тогда
 * шаблон не подходит вовсе: он ответит на половину, и клиенту придётся спрашивать заново.
 */
export function matchIntent(raw: string): IntentDef | null {
  const text = raw.toLowerCase();
  const hits = INTENTS.filter((i) => i.phrases.some((p) => text.includes(p)));
  return hits.length === 1 ? hits[0] : null;
}
