import { describe, it, expect } from "vitest";
import { classifyThread, normalizeForRules, isTopicKey, TOPIC_LABEL, TOPIC_KEYS, TOPIC_UI_ORDER } from "./otherMessages";

/**
 * Все примеры ниже — НАСТОЯЩИЕ сообщения с прода (выборка 300 последних непривязанных SMS,
 * сентябрь 2026). Выдуманных строк здесь быть не должно: правила писались под эти тексты, и
 * проверять их надо на них же.
 */
describe("категории «Других сообщений»", () => {
  it("рассылки про кредиты — спам", () => {
    expect(classifyThread(["Hi Emanouel, 24 mos terms cash injections + private credit facility over 60 mos terms. Reply YES for details  Reply STOP to opt out."])).toBe("SPAM");
    expect(classifyThread(["Hi Emanouel BAGHOUMIAN! It's Elli from Fast Biz Funds. I have  pre-approved for 100k Payback 118K. Interested? reply stop to unsubscribe"])).toBe("SPAM");
  });

  it("живого клиента по имени Emmanuelle спамом не считаем", () => {
    expect(classifyThread(["Hi, this is Emmanuelle. Can I come pick flowers up myself now?"])).toBe("PICKUP");
  });

  it("самовывоз и «не могу найти магазин» — одна категория", () => {
    expect(classifyThread(["can i come by and pick them up myself?"])).toBe("PICKUP");
    expect(classifyThread(["Hi can I do you take walk in order?"])).toBe("PICKUP");
    expect(classifyThread(["I can’t find your location - I followed Google maps. Looking to purchase a bouquet"])).toBe("PICKUP");
    expect(classifyThread(["Are you located in petco?"])).toBe("PICKUP");
  });

  it("доставка", () => {
    expect(classifyThread(["Hello, hope you're well! Do you offer same day (today) delivery for studio city?"])).toBe("DELIVERY");
  });

  it("хотят купить", () => {
    expect(classifyThread(["Yes I was hoping to place an order"])).toBe("NEW_ORDER");
    expect(classifyThread(["Can I place an order for today?"])).toBe("NEW_ORDER");
    expect(classifyThread(["Yes, I wanted to see if you had lillies, and if you could use flowers I had for an arrangement with the Lillie's."])).toBe("NEW_ORDER");
  });

  it("вакансия сильнее доставки: «delivery driver job» — это не про доставку букета", () => {
    expect(classifyThread(["Hi, are you hiring? I saw a delivery driver position, I have 3 years of experience"])).toBe("JOB");
  });

  it("служебное сильнее спама: код подтверждения — не рассылка", () => {
    expect(classifyThread(["Your verification code is: 483920. Reply STOP to opt out"])).toBe("SERVICE");
  });

  it("огрызок без контекста уходит в «Прочее», а не притворяется категорией", () => {
    expect(classifyThread(["Yes "])).toBe("OTHER");
    expect(classifyThread(["Hello"])).toBe("OTHER");
    expect(classifyThread(["4372416577"])).toBe("OTHER");
    expect(classifyThread([])).toBe("OTHER");
    expect(classifyThread([null, undefined, "  "])).toBe("OTHER");
  });

  it("категория считается по ВСЕЙ переписке, а не по последней реплике", () => {
    // Реальный порядок: сначала человек объясняет, потом отвечает односложно.
    expect(classifyThread(["Hi, I want to buy a bouquet for a birthday", "Yes", "Ok"])).toBe("NEW_ORDER");
  });

  it("нормализация: типографский апостроф с айфона не ломает правило", () => {
    expect(normalizeForRules("I CAN’T   FIND\nyour store")).toBe("i can't find your store");
    expect(classifyThread(["I can’t find your store"])).toBe("PICKUP");
  });

  it("у каждой категории есть русская подпись, и ключи проверяются", () => {
    for (const k of TOPIC_KEYS) expect(TOPIC_LABEL[k]).toBeTruthy();
    expect(isTopicKey("SPAM")).toBe(true);
    expect(isTopicKey("НЕТ_ТАКОЙ")).toBe(false);
    // Кнопки в интерфейсе обязаны покрывать ВСЕ категории: иначе поставленную правилом
    // категорию нельзя было бы снять руками.
    expect([...TOPIC_UI_ORDER].sort()).toEqual([...TOPIC_KEYS].sort());
  });
});
