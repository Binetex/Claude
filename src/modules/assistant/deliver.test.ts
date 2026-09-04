import { describe, it, expect } from "vitest";
import { pickOrderTarget, escapeHtml } from "./deliver";

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
