import { describe, it, expect } from "vitest";
import { findChainCycle, chainOccurrenceKey, isChainOccurrence, shouldWaitForReply, MAX_CHAIN_MESSAGES } from "./chain";

/**
 * Цепочка «не ответили — следующее правило». Здесь закреплены её предохранители: кольцо в
 * настройке и потолок сообщений на заказ. Оба — про живого человека, который иначе получает
 * SMS без конца.
 */
describe("поиск кольца в цепочке", () => {
  const links = (pairs: [string, string | null][]) => new Map<string, string | null>(pairs);

  it("прямая лесенка кольцом не считается", () => {
    // A → B → C, дальше ничего: обычная эскалация владельца.
    expect(findChainCycle(links([["b", "c"], ["c", null]]), "a", "b")).toBeNull();
  });

  it("ссылка на самого себя — кольцо", () => {
    expect(findChainCycle(links([]), "a", "a")).toEqual(["a", "a"]);
  });

  it("возврат к первому правилу через два шага — кольцо", () => {
    // A → B → C → A: каждый круг это ещё три сообщения человеку.
    expect(findChainCycle(links([["b", "c"], ["c", "a"]]), "a", "b")).toEqual(["a", "b", "c", "a"]);
  });

  it("кольцо ДАЛЬШЕ по цепочке тоже видно", () => {
    // A → B → C → B: сам A в кольцо не входит, но человек всё равно в нём окажется.
    expect(findChainCycle(links([["b", "c"], ["c", "b"]]), "a", "b")).not.toBeNull();
  });

  it("обрыв ссылки не зацикливает поиск", () => {
    expect(findChainCycle(links([["b", "unknown"]]), "a", "b")).toBeNull();
  });
});

describe("случай сообщения цепочки", () => {
  const key = (over: Partial<{ nextAutomationId: string; orderId: string; senderCase: string }> = {}) =>
    chainOccurrenceKey({ nextAutomationId: "next1", orderId: "o1", senderCase: "case1", ...over });

  it("новое сообщение того же правила даёт новый случай", () => {
    // Перенос даты доставки: вопрос уходит заново, и продолжение у него своё.
    expect(key()).not.toBe(key({ senderCase: "case2" }));
  });

  it("разные заказы не мешают друг другу", () => {
    expect(key()).not.toBe(key({ orderId: "o2" }));
  });

  it("два сообщения ОДНОГО правила (аудитория «Оба») дают ОДИН случай", () => {
    // Иначе молчание заказчика и получателя запустило бы продолжение дважды — и человек
    // получил бы одно и то же сообщение два раза.
    expect(key()).toBe(key());
  });

  it("два РАЗНЫХ правила, указывающих на одно следующее, дают ОДИН случай", () => {
    // На «Заказ доставлен» на проде висят два правила (заказчику и получателю). Если обоим
    // указать одно продолжение, человек обязан получить его один раз, а не два.
    // Случай зависит от правила-получателя и сообщения, а не от того, кто первым замолчал.
    expect(key()).toBe(key());
    expect(key()).not.toBe(key({ nextAutomationId: "next2" }));
  });

  it("сообщение цепочки отличимо от сообщения по событию заказа", () => {
    // От этого зависят и срок ожидания (первый или следующий), и потолок на заказ.
    expect(isChainOccurrence(key())).toBe(true);
    expect(isChainOccurrence("order123:2026-09-04")).toBe(false);
    expect(isChainOccurrence(null)).toBe(false);
  });

  it("потолок конечен и невелик", () => {
    expect(MAX_CHAIN_MESSAGES).toBeGreaterThan(2);
    expect(MAX_CHAIN_MESSAGES).toBeLessThanOrEqual(10);
  });
});

describe("ждать ли ответа на отправленное сообщение", () => {
  const link = { noReplyNextAutomationId: "next1" };

  it("SMS со ссылкой — ждём", () => {
    expect(shouldWaitForReply({ channel: "SMS", phoneNormalized: "+13105550100" }, link)).toBe(true);
  });

  it("ссылки нет — не ждём", () => {
    // Главная граница всей правки: раньше здесь стоял тип события «Доставка сегодня», и цепочку
    // заводило любое правило на него. Возврат к событию обязан ронять этот тест.
    expect(shouldWaitForReply({ channel: "SMS", phoneNormalized: "+13105550100" }, { noReplyNextAutomationId: null })).toBe(false);
  });

  it("письмо — не ждём: входящей почты система не принимает", () => {
    expect(shouldWaitForReply({ channel: "EMAIL", phoneNormalized: null }, link)).toBe(false);
  });

  it("SMS без номера — не ждём: ответ искать не по чему", () => {
    expect(shouldWaitForReply({ channel: "SMS", phoneNormalized: null }, link)).toBe(false);
  });
});
