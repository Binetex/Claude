import { describe, it, expect } from "vitest";
import { pickOrderTarget, escapeHtml, NUDGE_TEXT, nextSendKey } from "./deliver";

describe("pickOrderTarget", () => {
  const order = { senderPhone: "+13100000001", recipientPhone: "+13100000002" };

  it("адресат — по номеру входящего, а не по сохранённой роли", () => {
    expect(pickOrderTarget("+13100000002", "CUSTOMER", order)).toBe("RECIPIENT");
    expect(pickOrderTarget("+13100000001", "RECIPIENT", order)).toBe("CUSTOMER");
  });

  it("номер не из заказа — ни одной из сторон: отвечать через «заказчика» нельзя", () => {
    expect(pickOrderTarget("+13100000009", "CUSTOMER", order)).toBeNull();
  });

  it("без номера остаётся роль", () => {
    expect(pickOrderTarget(null, "RECIPIENT", order)).toBe("RECIPIENT");
    expect(pickOrderTarget(null, "UNKNOWN", order)).toBe("CUSTOMER");
  });
});

describe("escapeHtml", () => {
  it("текст клиента в Telegram — данные, а не разметка", () => {
    expect(escapeHtml("<3 you & me <b>")).toBe("&lt;3 you &amp; me &lt;b&gt;");
  });
});

describe("NUDGE_TEXT", () => {
  it("без длинных тире и по-английски", () => {
    expect(NUDGE_TEXT).not.toMatch(/[—–Ѐ-ӿ]/);
  });
});

describe("nextSendKey", () => {
  it("первая попытка — обычный ключ разбора", () => {
    expect(nextSendKey("t1", [])).toEqual({ key: "ai-turn:t1" });
  });

  it("после неудачи можно попробовать ещё раз: новый ключ, а не тупик", () => {
    // Quo отклонил (истекла подписка), владелец её продлил и жмёт «Отправить» снова.
    expect(nextSendKey("t1", [{ status: "FAILED" }])).toEqual({ key: "ai-turn:t1:2" });
    expect(nextSendKey("t1", [{ status: "FAILED" }, { status: "FAILED" }])).toEqual({ key: "ai-turn:t1:3" });
  });

  it("сообщение уже ушло — второго клиенту не шлём", () => {
    expect(nextSendKey("t1", [{ status: "SENT" }])).toEqual({ alreadySent: true });
    // PENDING — тоже «в пути»: ответ провайдера мог не дойти до нас, а SMS уйти.
    expect(nextSendKey("t1", [{ status: "FAILED" }, { status: "PENDING" }])).toEqual({ alreadySent: true });
  });
});
