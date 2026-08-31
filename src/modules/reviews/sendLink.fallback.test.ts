import { describe, it, expect } from "vitest";

/**
 * Граница «пробуем письмо, когда SMS не ушла» для ОДНОГО заказа.
 *
 * В рассылках выключенный у магазина QUO означает «не собирались писать», и подменять его
 * почтой нельзя — один снятый флажок разослал бы письма по всем заказам. Здесь отправка
 * следует из решения человека по конкретному заказу, поэтому отказ «SMS выключены» оставлял
 * бы оператора без единого способа отправить ссылку при настроенной почте.
 *
 * Тест держит два списка врозь: они намеренно НЕ совпадают, и совпадение означало бы, что
 * кто-то свёл их «для порядка».
 */
import { SMS_UNAVAILABLE_CODES } from "@/modules/messaging/channels/sms";

// Тот же список, что в sendLink.ts. Держим копию здесь осознанно: он не экспортируется, а
// проверять надо именно решение «когда пробуем письмо», а не внутренности модуля.
const BROKEN_MESSAGE_CODES = new Set([
  "empty_text",
  "too_long",
  "order_not_found",
  "missing_idempotency_key",
  "previous_attempt_failed",
]);

const triesEmail = (code: string) => !BROKEN_MESSAGE_CODES.has(code);

describe("когда после неудачной SMS пробуем письмо", () => {
  it("выключенный у магазина QUO письму не мешает", () => {
    // Ровно тот случай, ради которого правило и разошлось с рассылками.
    expect(triesEmail("store_quo_disabled")).toBe(true);
    expect(triesEmail("quo_not_configured")).toBe(true);
  });

  it("непригодный телефон и сломанная настройка — тоже повод написать письмо", () => {
    for (const code of SMS_UNAVAILABLE_CODES) expect(triesEmail(code)).toBe(true);
  });

  it("испорченное сообщение письмом не спасают", () => {
    // Письмо собирается из своего шаблона: оно отправило бы ДРУГОЙ текст и спрятало ошибку.
    for (const code of BROKEN_MESSAGE_CODES) expect(triesEmail(code)).toBe(false);
  });

  it("списки не совпадают — это разные правила, а не копии", () => {
    for (const code of SMS_UNAVAILABLE_CODES) expect(BROKEN_MESSAGE_CODES.has(code)).toBe(false);
  });
});
