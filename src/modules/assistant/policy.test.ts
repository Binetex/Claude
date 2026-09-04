import { describe, it, expect } from "vitest";
import { shouldConsider, decideDelivery, isSmallTalk, DAILY_CAP, ORDER_CAP, AUTOMATED_SILENCE_MIN } from "./policy";

/**
 * Правила ассистента. Каждая проверка здесь — про живого человека с телефоном: лишний ответ
 * читается как навязчивость, пропущенный — как молчание магазина.
 */
const NOW = new Date("2026-09-05T18:00:00.000Z");

const base = {
  mode: "AUTO_SIMPLE" as const,
  orderDisabled: false,
  orderClosed: false,
  deliveredAt: null,
  text: "where is my order?",
  lastAutomatedAt: null,
  repliesToday: 0,
  repliesTotal: 0,
  now: NOW,
};

describe("когда ассистент вообще вступает", () => {
  it("обычный вопрос по живому заказу — разбираем", () => {
    expect(shouldConsider(base)).toEqual({ ok: true });
  });

  it("выключен на магазине", () => {
    expect(shouldConsider({ ...base, mode: "OFF" })).toEqual({ ok: false, reason: "assistant_off" });
  });

  it("выключен на этом заказе — сильнее режима магазина", () => {
    expect(shouldConsider({ ...base, orderDisabled: true })).toEqual({ ok: false, reason: "order_disabled" });
  });

  it("заказ отменён — говорить не о чем", () => {
    expect(shouldConsider({ ...base, orderClosed: true })).toEqual({ ok: false, reason: "order_closed" });
  });

  it("доставлен больше трёх дней назад — молчим", () => {
    const old = new Date(NOW.getTime() - 4 * 86_400_000);
    expect(shouldConsider({ ...base, deliveredAt: old })).toEqual({ ok: false, reason: "delivered_long_ago" });
  });

  it("доставлен вчера — ещё разговариваем", () => {
    const recent = new Date(NOW.getTime() - 26 * 3_600_000);
    expect(shouldConsider({ ...base, deliveredAt: recent })).toEqual({ ok: true });
  });

  it("только что ушло автоматическое сообщение — ждём", () => {
    const justNow = new Date(NOW.getTime() - (AUTOMATED_SILENCE_MIN - 1) * 60_000);
    expect(shouldConsider({ ...base, lastAutomatedAt: justNow })).toEqual({ ok: false, reason: "recent_automated_message" });
  });

  it("автоматическое было давно — отвечаем", () => {
    const before = new Date(NOW.getTime() - (AUTOMATED_SILENCE_MIN + 1) * 60_000);
    expect(shouldConsider({ ...base, lastAutomatedAt: before })).toEqual({ ok: true });
  });

  it("потолок суток и потолок заказа", () => {
    expect(shouldConsider({ ...base, repliesToday: DAILY_CAP })).toEqual({ ok: false, reason: "daily_cap" });
    expect(shouldConsider({ ...base, repliesTotal: ORDER_CAP })).toEqual({ ok: false, reason: "order_cap" });
  });
});

describe("вежливая точка в разговоре", () => {
  it("на благодарности и «ок» не отвечаем", () => {
    for (const t of ["thanks", "Thank you!", "ok", "OK 👍", "👍", "❤️", "got it", "спасибо", "thanks so much"]) {
      expect(isSmallTalk(t)).toBe(true);
    }
  });

  it("вопрос благодарностью не считается", () => {
    for (const t of ["thanks, but where is it?", "ok what time?", "thank you, can I change the address"]) {
      expect(isSmallTalk(t)).toBe(false);
    }
  });

  it("пустое входящее не разбираем", () => {
    expect(shouldConsider({ ...base, text: "   " })).toEqual({ ok: false, reason: "empty_text" });
  });
});

describe("кто нажимает «отправить»", () => {
  const d = { mode: "AUTO_SIMPLE" as const, dryRun: false, hasReply: true, needsHuman: false, important: false };

  it("простое и уверенное в режиме автомата уходит само", () => {
    expect(decideDelivery(d)).toBe("send");
  });

  it("сухой прогон не выпускает наружу ничего", () => {
    expect(decideDelivery({ ...d, dryRun: true })).toBe("draft");
  });

  it("режим черновиков — всегда человек", () => {
    expect(decideDelivery({ ...d, mode: "DRAFT" })).toBe("draft");
  });

  it("важное и неуверенное смотрит человек", () => {
    expect(decideDelivery({ ...d, important: true })).toBe("draft");
    expect(decideDelivery({ ...d, needsHuman: true })).toBe("draft");
  });

  it("текста нет — отправлять нечего", () => {
    expect(decideDelivery({ ...d, hasReply: false })).toBe("draft");
  });
});
