import { describe, it, expect } from "vitest";
import { matchIntent, INTENTS, getIntent } from "./intents";

/**
 * Узнавание частых вопросов. Ошибка здесь дорога в обе стороны: не узнали — потратили запрос к
 * модели; узнали неверно — отправили клиенту заготовку не про то, что он спросил.
 */
describe("узнавание вопроса", () => {
  it("вопрос про трек", () => {
    expect(matchIntent("Hi, where is my order?")?.key).toBe("tracking");
    expect(matchIntent("can i get a tracking link")?.key).toBe("tracking");
  });

  it("вопрос про время", () => {
    expect(matchIntent("what time will it arrive?")?.key).toBe("delivery_time");
    expect(matchIntent("ETA please")?.key).toBe("delivery_time");
  });

  it("два вопроса сразу — шаблон не годится, отвечает модель", () => {
    // Заготовка ответит на половину, и клиенту придётся спрашивать заново.
    expect(matchIntent("where is my order and what time will it arrive?")).toBeNull();
  });

  it("незнакомый вопрос уходит модели", () => {
    expect(matchIntent("my mom is in the hospital, can you deliver to a different address?")).toBeNull();
  });
});

describe("сами заготовки", () => {
  it("у каждой есть текст по умолчанию и он английский", () => {
    for (const i of INTENTS) {
      expect(i.defaultText.trim().length).toBeGreaterThan(0);
      expect(i.defaultText).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it("шаблон с ссылкой требует саму ссылку", () => {
    // «Вот ваш трек» без трека хуже молчания.
    expect(getIntent("tracking")?.requires).toContain("tracking_url");
    expect(getIntent("delivery_time")?.requires).toContain("delivery_time");
  });
});
