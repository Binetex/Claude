import { describe, it, expect } from "vitest";
import { buildMessages, parseReply, type OrderSnapshot } from "./prompt";

/**
 * Что уходит в модель и как читается её ответ. Главное здесь — запреты: разбор устроен так,
 * что при любом сомнении ответ идёт человеку, а не клиенту.
 */
const order: OrderSnapshot = {
  orderNumber: "THEFLOW-20654",
  storeName: "TheFlow",
  orderStatus: "confirmed",
  deliveryStatus: "assigned",
  deliveryDate: "2026-09-05",
  deliveryWindow: "10:00-14:00",
  recipientName: "Jane",
  deliveryAddress: "123 Main St, Apt 4B",
  trackingUrl: "https://track/x",
  photoUrl: null,
  totalFormatted: "$120.00",
  party: "customer",
};

describe("запрос к модели", () => {
  it("для заказа отдаёт данные заказа и запреты", () => {
    const [system, user] = buildMessages({ knowledgeBase: "We deliver 9-6", order, history: [], incomingText: "where is it?" });

    expect(system.content).toContain("Reply ONLY in English");
    expect(system.content).toContain("NEVER reveal");
    expect(user.content).toContain("THEFLOW-20654");
    expect(user.content).toContain("We deliver 9-6");
    expect(user.content).toContain("where is it?");
  });

  it("для незнакомого номера — другой бот: сначала выясняет заказ", () => {
    const [system, user] = buildMessages({ knowledgeBase: "Hours 9-6", order: null, history: [], incomingText: "hi" });

    expect(system.content).toContain("NOT linked to any order");
    expect(system.content).toContain("find out which order");
    expect(user.content).not.toContain("Order data");
  });

  it("переписка идёт в запрос — ассистент не отвечает в вакууме", () => {
    const [, user] = buildMessages({
      knowledgeBase: null,
      order,
      history: [{ direction: "out", text: "Your flowers arrive today", at: "09:00" }],
      incomingText: "what time?",
    });
    expect(user.content).toContain("Your flowers arrive today");
  });
});

describe("разбор ответа модели", () => {
  it("нормальный ответ читается целиком", () => {
    const r = parseReply('{"reply_en":"It arrives today between 10 and 2.","intent":"delivery_time","important":false,"needs_human":false,"ready_time":null}');
    expect(r).toEqual({
      replyEn: "It arrives today between 10 and 2.",
      intent: "delivery_time",
      important: false,
      needsHuman: false,
      readyTime: null,
      orderHint: null,
    });
  });

  it("обёртка ```json не мешает", () => {
    const r = parseReply('```json\n{"reply_en":"Hi","intent":"other","important":false,"needs_human":false,"ready_time":null}\n```');
    expect(r.replyEn).toBe("Hi");
  });

  it("сломанный ответ уходит человеку, а не клиенту", () => {
    const r = parseReply("извини, я не смог");
    expect(r.needsHuman).toBe(true);
    expect(r.replyEn).toBe("");
  });

  it("пустой текст ответа — тоже человеку", () => {
    const r = parseReply('{"reply_en":"","intent":"other","important":false,"needs_human":false}');
    expect(r.needsHuman).toBe(true);
  });

  it("русский текст клиенту не уходит НИКОГДА", () => {
    // Правило владельца жёстче инструкции в промпте: инструкцию модель может проигнорировать,
    // эту проверку — нет.
    const r = parseReply('{"reply_en":"Здравствуйте, ваш заказ в пути","intent":"tracking","important":false,"needs_human":false}');
    expect(r.replyEn).toBe("");
    expect(r.needsHuman).toBe(true);
  });

  it("время готовности вытаскивается словами клиента", () => {
    const r = parseReply('{"reply_en":"Got it, after 5pm.","intent":"delivery_time","important":false,"needs_human":false,"ready_time":"after 5pm"}');
    expect(r.readyTime).toBe("after 5pm");
  });

  it("важная тема помечается", () => {
    const r = parseReply('{"reply_en":"A team member will follow up.","intent":"refund","important":true,"needs_human":true,"ready_time":null}');
    expect(r.important).toBe(true);
    expect(r.needsHuman).toBe(true);
  });
});

describe("подсказка о заказе от незнакомого номера", () => {
  it("имя или адрес читаются как сказал человек", () => {
    const r = parseReply('{"reply_en":"Thanks, one moment.","intent":"other","important":false,"needs_human":false,"ready_time":null,"order_hint":"Maria Lopez"}');
    expect(r.orderHint).toBe("Maria Lopez");
  });

  it("нет подсказки — нет привязки", () => {
    const r = parseReply('{"reply_en":"Hi","intent":"other","important":false,"needs_human":false}');
    expect(r.orderHint).toBeNull();
  });
});
