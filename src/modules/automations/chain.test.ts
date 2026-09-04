import { describe, it, expect } from "vitest";
import { orderByChain, findChainCycle, chainOccurrenceKey, isChainOccurrence, shouldWaitForReply, splitWait, joinWait, formatWait, clampWait, MIN_WAIT_MIN, MAX_WAIT_MIN, MAX_CHAIN_MESSAGES } from "./chain";

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

describe("срок ожидания в понятных единицах", () => {
  it("минуты раскладываются в самую крупную единицу без остатка", () => {
    expect(splitWait(45)).toEqual({ amount: 45, unit: "MINUTE" });
    expect(splitWait(120)).toEqual({ amount: 2, unit: "HOUR" });
    expect(splitWait(2880)).toEqual({ amount: 2, unit: "DAY" });
    expect(splitWait(90)).toEqual({ amount: 90, unit: "MINUTE" }); // 1.5 часа не врём про «часы»
  });

  it("собирается обратно ровно тем же числом минут", () => {
    for (const m of [5, 45, 60, 90, 120, 1440, 2880, 10080]) {
      const { amount, unit } = splitWait(m);
      expect(joinWait(amount, unit)).toBe(m);
    }
  });

  it("ждать можно до двух недель — «напомнить через неделю» это нормальный шаг", () => {
    expect(clampWait(joinWait(7, "DAY"), 60)).toBe(7 * 24 * 60);
    expect(MAX_WAIT_MIN).toBe(14 * 24 * 60);
  });

  it("границы режутся: минута тревожит зря, месяц уже не про этот заказ", () => {
    expect(clampWait(1, 60)).toBe(MIN_WAIT_MIN);
    expect(clampWait(60 * 24 * 30, 60)).toBe(MAX_WAIT_MIN);
  });
});

describe("порядок списка: цепочка читается сверху вниз", () => {
  const r = (id: string, next: string | null = null) => ({ id, noReplyNextAutomationId: next });

  it("шаги встают под своим родителем со сдвигом", () => {
    // В базе они лежат в обратном порядке — список обязан показать лесенку правильно.
    const res = orderByChain([r("c"), r("a", "b"), r("b", "c")]);
    expect(res.map((x) => [x.rule.id, x.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("одиночные правила остаются на своём месте", () => {
    const res = orderByChain([r("solo1"), r("a", "b"), r("b"), r("solo2")]);
    expect(res.map((x) => x.rule.id)).toEqual(["solo1", "a", "b", "solo2"]);
  });

  it("ни одно правило не теряется и не показывается дважды", () => {
    // Даже если ссылки образуют кольцо (сохранить его нельзя, но данные бывают всякие).
    const res = orderByChain([r("a", "b"), r("b", "a"), r("c")]);
    expect(res.map((x) => x.rule.id).sort()).toEqual(["a", "b", "c"]);
    expect(res).toHaveLength(3);
  });
});

describe("подпись срока по-русски", () => {
  it("число и слово согласованы", () => {
    // «ждёт ответ 1 часов» в списке правил читается как небрежность.
    expect(formatWait(60)).toBe("1 час");
    expect(formatWait(120)).toBe("2 часа");
    expect(formatWait(300)).toBe("5 часов");
    expect(formatWait(1440)).toBe("1 день");
    expect(formatWait(2880)).toBe("2 дня");
    expect(formatWait(45)).toBe("45 минут");
    expect(formatWait(21 * 60)).toBe("21 час");
  });
});
